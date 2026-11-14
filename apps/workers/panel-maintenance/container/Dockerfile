# The PyIceberg job panel-maintenance runs in a Cloudflare Container: erasures
# and retention for the WeldPanel Iceberg tables (docs/plans/weldpanel.md,
# "Privacy and GDPR"). It listens on 8080; the Worker drives it over HTTP.
FROM python:3.12-slim

WORKDIR /app
# Wheels only: no package's setup script runs at build time. Every dependency
# of pyiceberg[pyarrow] 0.9.1 ships a manylinux wheel for Python 3.12.
RUN pip install --no-cache-dir --only-binary :all: "pyiceberg[pyarrow]==0.9.1"
COPY maintenance.py server.py ./

# Run as an unprivileged user; the job needs no write access to the image.
RUN useradd --system --no-create-home --uid 10001 maintenance
USER maintenance

ENV PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "server.py"]
