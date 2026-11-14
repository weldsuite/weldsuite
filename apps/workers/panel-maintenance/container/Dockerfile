# The PyIceberg job panel-maintenance runs in a Cloudflare Container: erasures
# and retention for the WeldPanel Iceberg tables (docs/plans/weldpanel.md,
# "Privacy and GDPR"). It listens on 8080; the Worker drives it over HTTP.
FROM python:3.12-slim

WORKDIR /app
RUN pip install --no-cache-dir "pyiceberg[pyarrow]==0.9.1"
COPY maintenance.py server.py ./

ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "server.py"]
