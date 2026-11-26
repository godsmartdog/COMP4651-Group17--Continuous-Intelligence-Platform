FROM python:3.11-slim

# Install Java 17 (required by PySpark) and curl for downloading Postgres JDBC jar
RUN apt-get update && \
    apt-get install -y --no-install-recommends openjdk-17-jre-headless curl procps && \
    rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
    PYSPARK_PYTHON=python3 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /workspace/4_spark_pipeline

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download PostgreSQL JDBC driver so Spark can read/write Cloud or Local Postgres
RUN mkdir -p /opt/spark-jars && \
    curl -fsSL https://jdbc.postgresql.org/download/postgresql-42.7.4.jar -o /opt/spark-jars/postgresql-42.7.4.jar

COPY . .

CMD ["python3", "--version"]
