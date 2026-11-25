FROM python:3.11-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py core.py texts.py ./
COPY static ./static
RUN chmod a+r main.py core.py texts.py && chmod -R a+rX static && useradd --create-home appuser && mkdir /app/data && chown appuser:appuser /app/data
USER appuser
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
