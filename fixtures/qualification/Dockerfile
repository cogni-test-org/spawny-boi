# syntax=docker/dockerfile:1.7-labs@sha256:b99fecfe00268a8b556fad7d9c37ee25d716ae08a5d7320e6d51c4dd83246894
# Same BUILD_SHA contract as the app; stdlib only, no runtime secret inputs.
FROM python:3.12-alpine@sha256:e6dae589c1c05976188fd3bd019afd091445fc533ed2ea29001beddc7368a9c8 AS runner
RUN addgroup -S fixture && adduser -S -G fixture fixture
WORKDIR /fixture
COPY --chown=fixture:fixture fixtures/qualification/helper.py ./helper.py
ARG BUILD_SHA
ENV APP_BUILD_SHA=$BUILD_SHA PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=9101
USER fixture
EXPOSE 9101
CMD ["python3", "helper.py"]
