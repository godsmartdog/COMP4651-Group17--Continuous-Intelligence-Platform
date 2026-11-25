"""Build a versioned Silver and Gold catalog from bronze GH Archive hours.

Deduplication and repository aggregation run in Spark. The job writes a
partial snapshot, checks that parquet, and publishes it only when every
check passes.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
import zlib
from dataclasses import dataclass
from pathlib import Path

import github_api
import schemas
from catalog.parse import EVENT_COLUMNS, REJECT_COLUMNS, RejectedEvent, parse_line
from pyspark.sql import DataFrame, SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import (
    ArrayType,
    BooleanType,
    LongType,
    StringType,
    StructField,
    StructType,
)
from pyspark.sql.window import Window


ACTIVITY = (
    ("watch_count", "WatchEvent"),
    ("fork_count", "ForkEvent"),
    ("push_count", "PushEvent"),
    ("issues_count", "IssuesEvent"),
    ("pull_request_count", "PullRequestEvent"),
)

GOLD_COLUMNS = (
    "snapshot_id",
    "repo_id",
    "full_name",
    "description",
    "topics",
    "language",
    "html_url",
    "repo_created_at",
    "metadata_fetched_at",
    "enrichment_status",
    "visibility",
    "archived",
    "api_stargazers_count",
    "api_forks_count",
    "as_of",
    "last_event_time",
    "event_count",
    "watch_count",
    "fork_count",
    "push_count",
    "issues_count",
    "pull_request_count",
    "window_24h_watch_count",
    "window_24h_fork_count",
    "window_24h_push_count",
    "window_24h_issues_count",
    "window_24h_pull_request_count",
    "window_7d_watch_count",
    "window_7d_fork_count",
    "window_7d_push_count",
    "window_7d_issues_count",
    "window_7d_pull_request_count",
)

_META_COLUMNS = (
    "repo_id",
    "m_full_name",
    "description",
    "topics",
    "language",
    "html_url",
    "repo_created_at",
    "metadata_fetched_at",
    "visibility",
    "archived",
    "api_stargazers_count",
    "api_forks_count",
)

_TS_FORMAT = "yyyy-MM-dd'T'HH:mm:ss'Z'"
_DAY_SECONDS = 24 * 60 * 60


class SparkEnvironmentError(RuntimeError):
    """JAVA_HOME or HADOOP_HOME is missing."""


class CatalogNotPublished(RuntimeError):
    """The run failed before CURRENT was updated."""


@dataclass(frozen=True)
class _ArchiveHour:
    archive_hour: str
    ingested_at: str
    sha256: str
    path: Path


def prepare_spark_env() -> Path:
    """Require a JDK and Hadoop home, and point Spark at this interpreter."""
    java = os.environ.get("JAVA_HOME", "").strip()
    hadoop = os.environ.get("HADOOP_HOME", "").strip()
    if not java and not hadoop:
        raise SparkEnvironmentError("JAVA_HOME and HADOOP_HOME are not set")
    if not java:
        raise SparkEnvironmentError("JAVA_HOME is not set")
    if not hadoop:
        raise SparkEnvironmentError("HADOOP_HOME is not set")
    java_home = Path(java)
    hadoop_home = Path(hadoop)
    if not (java_home / "bin").is_dir():
        raise SparkEnvironmentError(f"JAVA_HOME does not exist: {java_home}")
    if not (hadoop_home / "bin").is_dir():
        raise SparkEnvironmentError(f"HADOOP_HOME does not exist: {hadoop_home}")
    if not os.environ.get("PYSPARK_PYTHON"):
        os.environ["PYSPARK_PYTHON"] = sys.executable
    if not os.environ.get("PYSPARK_DRIVER_PYTHON"):
        os.environ["PYSPARK_DRIVER_PYTHON"] = os.environ["PYSPARK_PYTHON"]
    os.environ["SPARK_LOCAL_IP"] = "127.0.0.1"
    _prepend_path(str(java_home / "bin"), str(hadoop_home / "bin"))
    return hadoop_home


def spark_session() -> SparkSession:
    """Local session used by the CLI and the tests."""
    hadoop_home = prepare_spark_env()
    hadoop_bin = str(hadoop_home / "bin")
    warehouse = Path(tempfile.gettempdir()) / "gitpulse-spark" / "warehouse"
    derby = Path(tempfile.gettempdir()) / "gitpulse-spark" / "derby"
    warehouse.mkdir(parents=True, exist_ok=True)
    derby.mkdir(parents=True, exist_ok=True)
    session = (
        SparkSession.builder.master("local[*]")
        .appName("gitpulse-catalog")
        .config("spark.driver.extraLibraryPath", hadoop_bin)
        .config("spark.executor.extraLibraryPath", hadoop_bin)
        .config("spark.driver.host", "127.0.0.1")
        .config("spark.driver.bindAddress", "127.0.0.1")
        .config("spark.ui.enabled", "false")
        .config("spark.ui.showConsoleProgress", "false")
        .config("spark.sql.session.timeZone", "UTC")
        .config("spark.sql.shuffle.partitions", "4")
        .config("spark.sql.warehouse.dir", warehouse.resolve().as_posix())
        .config("spark.driver.extraJavaOptions", f"-Dderby.system.home={derby.resolve().as_posix()}")
        .getOrCreate()
    )
    session.sparkContext.setLogLevel("ERROR")
    session._jsc.hadoopConfiguration().set("fs.file.impl.disable.cache", "true")
    return session


def build_catalog(bronze_root: Path | str, lake_root: Path | str) -> str:
    """Publish one catalog snapshot and return its id."""
    bronze = Path(bronze_root)
    lake = Path(lake_root)
    hours = _load_hours(bronze)
    responses = _load_responses(bronze)
    snapshot_id = _snapshot_id(_fingerprint_lines(hours, responses))
    passing = _passing_checks(lake, snapshot_id)
    if passing is not None:
        if _current_id(lake) != snapshot_id:
            publish_current(lake, snapshot_id, passing)
        return snapshot_id

    _delete_snapshot(lake, snapshot_id, partial=True)
    _delete_snapshot(lake, snapshot_id, partial=False)
    events, rejected = _read_events(bronze, hours)
    metadata = _choose_metadata(responses)
    spark = spark_session()
    try:
        partial = _snapshot_paths(lake, snapshot_id, partial=True)
        silver = _dedup(_event_frame(spark, events))
        gold = _gold(spark, silver, metadata, snapshot_id)
        quarantine = _reject_frame(spark, rejected)
        _write_parquet(silver, partial["events"])
        _write_parquet(quarantine, partial["quarantine"])
        _write_parquet(gold, partial["repositories"])
        report = _validate(spark, partial, snapshot_id)
    finally:
        _stop_spark()

    if any(not value for value in report["checks"].values()):
        _delete_snapshot(lake, snapshot_id, partial=True)
        failed = ", ".join(name for name, ok in report["checks"].items() if not ok)
        raise CatalogNotPublished(f"catalog checks failed: {failed}")

    _write_quality(partial["gold"], report)
    _promote(lake, snapshot_id)
    if not publish_current(lake, snapshot_id, report["checks"]):
        raise CatalogNotPublished(f"catalog checks failed for {snapshot_id}")
    return snapshot_id


def publish_current(lake_root: Path | str, snapshot_id: str, checks: dict[str, bool]) -> bool:
    """Point CURRENT at ``snapshot_id`` when every check is true.

    A false check leaves CURRENT unchanged and returns False.
    """
    if any(not value for value in checks.values()):
        return False
    path = Path(lake_root) / "gold" / "catalog" / "CURRENT"
    schemas.atomic_write(path, (str(snapshot_id) + "\n").encode("utf-8"))
    return True


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build a Silver and Gold catalog snapshot from bronze archives."
    )
    parser.add_argument("--bronze-root", required=True)
    parser.add_argument("--lake-root", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        prepare_spark_env()
    except SparkEnvironmentError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    try:
        snapshot_id = build_catalog(args.bronze_root, args.lake_root)
    except CatalogNotPublished as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(snapshot_id)
    return 0


def _prepend_path(*entries: str) -> None:
    current = os.environ.get("PATH", "")
    parts = current.split(os.pathsep) if current else []
    prefix = [entry for entry in entries if entry and entry not in parts]
    if prefix:
        os.environ["PATH"] = os.pathsep.join(prefix + parts)


def _snapshot_id(lines: list[str]) -> str:
    payload = "".join(f"{line}\n" for line in sorted(lines)).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


def _fingerprint_lines(hours: list[_ArchiveHour], responses: list[Path]) -> list[str]:
    lines = [
        f"archive\t{hour.archive_hour}\t{hour.sha256}\t{hour.ingested_at}"
        for hour in hours
    ]
    for path in responses:
        repo_id = path.parent.parent.name.split("=", 1)[1]
        fetched_at = path.parent.name.split("=", 1)[1]
        lines.append(f"enrich\t{repo_id}\t{fetched_at}\t{_sha256(path)}")
    return lines


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_hours(bronze: Path) -> list[_ArchiveHour]:
    root = bronze / "gharchive"
    if not root.is_dir():
        return []
    hours = []
    for manifest_path in sorted(root.glob("year=*/month=*/day=*/hour=*/manifest.json")):
        try:
            manifest = schemas.read_manifest(manifest_path)
        except (OSError, ValueError, json.JSONDecodeError, KeyError) as exc:
            raise CatalogNotPublished(f"cannot read manifest {manifest_path}: {exc}") from exc
        if manifest.fetch_status != "downloaded":
            continue
        gzips = sorted(manifest_path.parent.glob("*.json.gz"))
        if not gzips:
            raise CatalogNotPublished(f"downloaded manifest has no gzip sibling: {manifest_path}")
        if len(gzips) != 1:
            raise CatalogNotPublished(f"downloaded manifest has multiple gzip siblings: {manifest_path}")
        hours.append(
            _ArchiveHour(manifest.archive_hour, manifest.ingested_at, manifest.sha256, gzips[0])
        )
    return hours


def _load_responses(bronze: Path) -> list[Path]:
    root = bronze / "github_api"
    if not root.is_dir():
        return []
    return sorted(root.glob("repo_id=*/fetched_at=*/response.json"))


def _read_events(
    bronze: Path,
    hours: list[_ArchiveHour],
) -> tuple[list, list[RejectedEvent]]:
    events = []
    rejected: list[RejectedEvent] = []
    for hour in hours:
        source_path = hour.path.resolve().relative_to(bronze.resolve()).as_posix()
        line_no = 0
        try:
            with gzip.open(hour.path, "rb") as handle:
                for raw in handle:
                    line_no += 1
                    if raw.endswith(b"\n"):
                        raw = raw[:-1]
                    if raw.endswith(b"\r"):
                        raw = raw[:-1]
                    try:
                        text = raw.decode("utf-8")
                    except UnicodeDecodeError:
                        rejected.append(
                            RejectedEvent(
                                "malformed_json",
                                source_path,
                                hour.archive_hour,
                                line_no,
                                raw.decode("utf-8", "replace")[:500],
                            )
                        )
                        continue
                    parsed = parse_line(
                        text,
                        archive_hour=hour.archive_hour,
                        ingested_at=hour.ingested_at,
                        source_path=source_path,
                        line_no=line_no,
                    )
                    if parsed is None:
                        continue
                    if isinstance(parsed, RejectedEvent):
                        rejected.append(parsed)
                    else:
                        events.append(parsed)
        except (OSError, EOFError, zlib.error, gzip.BadGzipFile) as exc:
            raise CatalogNotPublished(f"cannot read archive {hour.path}: {exc}") from exc
    return events, rejected


def _choose_metadata(responses: list[Path]) -> list[dict[str, object]]:
    chosen: dict[int, tuple[str, dict[str, object]]] = {}
    for path in responses:
        repo_id, fetched_at = _response_identity(path)
        if repo_id is None or fetched_at is None:
            continue
        # The API id must match the repo_id in the path. A mismatched or error
        # body stays in the fingerprint and does not become metadata.
        parsed = github_api._parse_repository(path.read_bytes(), repo_id, "")
        if parsed is None:
            continue
        current = chosen.get(repo_id)
        if current is None or fetched_at > current[0]:
            chosen[repo_id] = (fetched_at, parsed)
    rows = []
    for repo_id, (fetched_at, parsed) in sorted(chosen.items()):
        topics = parsed["topics"]
        rows.append(
            {
                "repo_id": repo_id,
                "m_full_name": parsed["full_name"],
                "description": parsed["description"],
                "topics": list(topics) if isinstance(topics, list) else [],
                "language": parsed["language"],
                "html_url": parsed["html_url"],
                "repo_created_at": parsed["created_at"],
                "metadata_fetched_at": fetched_at,
                "visibility": parsed["visibility"],
                "archived": parsed["archived"],
                "api_stargazers_count": parsed["stargazers_count"],
                "api_forks_count": parsed["forks_count"],
            }
        )
    return rows


def _response_identity(path: Path) -> tuple[int | None, str | None]:
    repo_name = path.parent.parent.name
    fetched_name = path.parent.name
    if not repo_name.startswith("repo_id=") or not fetched_name.startswith("fetched_at="):
        return None, None
    token = repo_name.split("=", 1)[1]
    fetched_at = fetched_name.split("=", 1)[1]
    if not token.isdigit() or int(token) <= 0:
        return None, None
    return int(token), fetched_at


def _event_schema() -> StructType:
    types = {name: StringType() for name in EVENT_COLUMNS}
    types["repo_id"] = LongType()
    types["actor_id"] = LongType()
    nullable = {"actor_id", "actor_login", "payload_action"}
    return StructType(
        [StructField(name, types[name], name in nullable) for name in EVENT_COLUMNS]
    )


def _reject_schema() -> StructType:
    types = {name: StringType() for name in REJECT_COLUMNS}
    types["line_no"] = LongType()
    return StructType([StructField(name, types[name], False) for name in REJECT_COLUMNS])


def _gold_schema() -> StructType:
    optional = {
        "description",
        "topics",
        "language",
        "html_url",
        "repo_created_at",
        "metadata_fetched_at",
        "visibility",
        "archived",
        "api_stargazers_count",
        "api_forks_count",
    }
    fields = []
    for name in GOLD_COLUMNS:
        if name == "topics":
            data_type = ArrayType(StringType(), True)
        elif name == "archived":
            data_type = BooleanType()
        elif name in {"repo_id", "event_count", "api_stargazers_count", "api_forks_count"} or _is_count(name):
            data_type = LongType()
        else:
            data_type = StringType()
        fields.append(StructField(name, data_type, name in optional))
    return StructType(fields)


def _meta_schema() -> StructType:
    return StructType(
        [
            StructField("repo_id", LongType(), False),
            StructField("m_full_name", StringType(), True),
            StructField("description", StringType(), True),
            StructField("topics", ArrayType(StringType(), True), True),
            StructField("language", StringType(), True),
            StructField("html_url", StringType(), True),
            StructField("repo_created_at", StringType(), True),
            StructField("metadata_fetched_at", StringType(), True),
            StructField("visibility", StringType(), True),
            StructField("archived", BooleanType(), True),
            StructField("api_stargazers_count", LongType(), True),
            StructField("api_forks_count", LongType(), True),
        ]
    )


def _is_count(name: str) -> bool:
    if name in {column for column, _event_type in ACTIVITY}:
        return True
    return name.startswith("window_24h_") or name.startswith("window_7d_")


def _event_frame(spark: SparkSession, events: list) -> DataFrame:
    return spark.createDataFrame([event.to_row() for event in events], schema=_event_schema())


def _reject_frame(spark: SparkSession, rejected: list[RejectedEvent]) -> DataFrame:
    return spark.createDataFrame([row.to_row() for row in rejected], schema=_reject_schema())


def _dedup(events: DataFrame) -> DataFrame:
    # Newest archive_hour, then newest ingested_at, then lowest source_path.
    order = Window.partitionBy("event_id", "repo_id").orderBy(
        F.col("archive_hour").desc(),
        F.col("ingested_at").desc(),
        F.col("source_path").asc(),
    )
    ranked = events.withColumn("_rn", F.row_number().over(order))
    return ranked.where(F.col("_rn") == 1).drop("_rn").select(*EVENT_COLUMNS)


def _gold(
    spark: SparkSession,
    silver: DataFrame,
    metadata: list[dict[str, object]],
    snapshot_id: str,
) -> DataFrame:
    as_of = silver.agg(F.max("event_time").alias("as_of")).collect()[0]["as_of"]
    if as_of is None:
        return spark.createDataFrame([], _gold_schema())
    framed = _with_windows(silver, as_of)
    aggregates = [
        F.max(F.struct(F.col("event_time"), F.col("repo_name"))).alias("_latest"),
        F.max("event_time").alias("last_event_time"),
        F.count(F.lit(1)).alias("event_count"),
    ]
    for column, event_type in ACTIVITY:
        aggregates.append(_typed_count(event_type, None).alias(column))
        aggregates.append(_typed_count(event_type, "_in_24h").alias(f"window_24h_{column}"))
        aggregates.append(_typed_count(event_type, "_in_7d").alias(f"window_7d_{column}"))
    grouped = framed.groupBy("repo_id").agg(*aggregates)
    meta = spark.createDataFrame(
        [tuple(row[name] for name in _META_COLUMNS) for row in metadata],
        schema=_meta_schema(),
    )
    joined = grouped.join(meta, "repo_id", "left")
    complete = F.col("metadata_fetched_at").isNotNull()
    values = {
        "snapshot_id": F.lit(snapshot_id),
        "repo_id": F.col("repo_id"),
        "full_name": F.when(complete, F.col("m_full_name")).otherwise(
            F.col("_latest").getField("repo_name")
        ),
        "description": F.col("description"),
        "topics": F.col("topics"),
        "language": F.col("language"),
        "html_url": F.col("html_url"),
        "repo_created_at": F.col("repo_created_at"),
        "metadata_fetched_at": F.col("metadata_fetched_at"),
        "enrichment_status": F.when(complete, F.lit("complete")).otherwise(F.lit("incomplete")),
        "visibility": F.col("visibility"),
        "archived": F.col("archived"),
        "api_stargazers_count": F.col("api_stargazers_count"),
        "api_forks_count": F.col("api_forks_count"),
        "as_of": F.lit(as_of),
        "last_event_time": F.col("last_event_time"),
        "event_count": F.col("event_count"),
    }
    for column, _event_type in ACTIVITY:
        values[column] = F.col(column)
        values[f"window_24h_{column}"] = F.col(f"window_24h_{column}")
        values[f"window_7d_{column}"] = F.col(f"window_7d_{column}")
    return joined.select(*[values[name].alias(name) for name in GOLD_COLUMNS])


def _with_windows(silver: DataFrame, as_of: str) -> DataFrame:
    # as_of is the latest silver event_time. A window includes event_time >= as_of
    # minus the span and event_time <= as_of, compared as timestamps.
    event_ts = F.unix_timestamp(F.col("event_time"), _TS_FORMAT)
    anchor = F.unix_timestamp(F.lit(as_of), _TS_FORMAT)
    return silver.withColumn(
        "_in_24h",
        (event_ts >= anchor - F.lit(_DAY_SECONDS)) & (event_ts <= anchor),
    ).withColumn(
        "_in_7d",
        (event_ts >= anchor - F.lit(7 * _DAY_SECONDS)) & (event_ts <= anchor),
    )


def _typed_count(event_type: str, flag: str | None):
    condition = F.col("event_type") == F.lit(event_type)
    if flag is not None:
        condition = condition & F.col(flag)
    return F.sum(F.when(condition, F.lit(1)).otherwise(F.lit(0)))


def _write_parquet(frame: DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.coalesce(1).write.mode("overwrite").parquet(str(path))


def _validate(spark: SparkSession, partial: dict[str, Path], snapshot_id: str) -> dict[str, object]:
    silver = spark.read.parquet(str(partial["events"]))
    gold = spark.read.parquet(str(partial["repositories"]))
    quarantine = spark.read.parquet(str(partial["quarantine"]))
    silver_rows = silver.count()
    gold_rows = gold.count()
    quarantine_rows = quarantine.count()
    unique_events = silver_rows == silver.select("event_id", "repo_id").distinct().count()
    unique_repos = gold_rows == gold.select("repo_id").distinct().count()
    event_counts_match = _sum_column(gold, "event_count") == silver_rows
    typed_totals = silver.agg(
        *[
            _typed_count(event_type, None).alias(column)
            for column, event_type in ACTIVITY
        ]
    ).collect()[0]
    typed_counts_match = all(
        _sum_column(gold, column) == int(typed_totals[column] or 0)
        for column, _event_type in ACTIVITY
    )
    window_counts_match = _windows_match(silver, gold, silver_rows)
    return {
        "snapshot_id": snapshot_id,
        "silver_rows": int(silver_rows),
        "gold_rows": int(gold_rows),
        "quarantine_rows": int(quarantine_rows),
        "checks": {
            "unique_events": bool(unique_events),
            "unique_repos": bool(unique_repos),
            "event_counts_match": bool(event_counts_match),
            "typed_counts_match": bool(typed_counts_match),
            "window_counts_match": bool(window_counts_match),
        },
    }


def _windows_match(silver: DataFrame, gold: DataFrame, silver_rows: int) -> bool:
    if silver_rows == 0:
        return all(_sum_column(gold, name) == 0 for name in _window_column_names())
    as_of = silver.agg(F.max("event_time")).collect()[0][0]
    stamped = _with_windows(silver, as_of)
    totals = stamped.agg(
        *[
            _typed_count(event_type, flag).alias(f"{prefix}{column}")
            for prefix, flag in (("window_24h_", "_in_24h"), ("window_7d_", "_in_7d"))
            for column, event_type in ACTIVITY
        ]
    ).collect()[0]
    return all(
        _sum_column(gold, name) == int(totals[name] or 0) for name in _window_column_names()
    )


def _window_column_names() -> tuple[str, ...]:
    names = []
    for prefix in ("window_24h_", "window_7d_"):
        for column, _event_type in ACTIVITY:
            names.append(f"{prefix}{column}")
    return tuple(names)


def _sum_column(frame: DataFrame, column: str) -> int:
    value = frame.agg(F.sum(F.col(column)).alias("total")).collect()[0]["total"]
    if value is None:
        return 0
    return int(value)


def _write_quality(gold_dir: Path, report: dict[str, object]) -> None:
    payload = json.dumps(report, indent=2).encode("utf-8") + b"\n"
    (gold_dir / "quality.json").write_bytes(payload)


def _promote(lake: Path, snapshot_id: str) -> None:
    partial = _snapshot_paths(lake, snapshot_id, partial=True)
    final = _snapshot_paths(lake, snapshot_id, partial=False)
    for key in ("events", "quarantine", "gold"):
        destination = final[key]
        if destination.exists():
            _remove_tree(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        _replace(partial[key], destination)


def _passing_checks(lake: Path, snapshot_id: str) -> dict[str, bool] | None:
    path = _snapshot_paths(lake, snapshot_id, partial=False)["gold"] / "quality.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    checks = data.get("checks")
    if data.get("snapshot_id") != snapshot_id or not isinstance(checks, dict) or not checks:
        return None
    if any(not value for value in checks.values()):
        return None
    return {str(name): bool(value) for name, value in checks.items()}


def _current_id(lake: Path) -> str | None:
    path = lake / "gold" / "catalog" / "CURRENT"
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8").strip()
    return text or None


def _snapshot_paths(lake: Path, snapshot_id: str, *, partial: bool) -> dict[str, Path]:
    name = f"snapshot_id={snapshot_id}" + (".partial" if partial else "")
    gold = lake / "gold" / "catalog" / name
    return {
        "events": lake / "silver" / "events" / name,
        "quarantine": lake / "silver" / "quarantine" / name,
        "gold": gold,
        "repositories": gold / "repositories",
    }


def _delete_snapshot(lake: Path, snapshot_id: str, *, partial: bool) -> None:
    paths = _snapshot_paths(lake, snapshot_id, partial=partial)
    for key in ("events", "quarantine", "gold"):
        _remove_tree(paths[key])


def _remove_tree(path: Path) -> None:
    if not path.exists():
        return

    def delete() -> None:
        shutil.rmtree(path)

    _retry_io(delete)


def _replace(source: Path, destination: Path) -> None:
    def move() -> None:
        os.replace(source, destination)

    _retry_io(move)


def _retry_io(action, attempts: int = 20) -> None:
    last: Exception | None = None
    for _ in range(attempts):
        try:
            action()
            return
        except PermissionError as exc:
            last = exc
            time.sleep(0.25)
    raise CatalogNotPublished(f"could not publish snapshot files: {last}")


def _stop_spark() -> None:
    session = SparkSession.getActiveSession()
    if session is None:
        return
    try:
        session.catalog.clearCache()
    except Exception:
        pass
    session.stop()


if __name__ == "__main__":
    raise SystemExit(main())
