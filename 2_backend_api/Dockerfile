FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

EXPOSE 8000

# Shell form allows cloud hosts (Render/Railway/Cloud Run) to inject $PORT dynamically
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
