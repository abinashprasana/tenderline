"""Application settings. Every variable is documented in .env.example and SETUP.md."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    # dev | prod | test. Defaults to prod so that forgetting to set it can never enable the dev-only token endpoint.
    env: str = "prod"
    service_name: str = "tenderline-api"
    workflows_enabled: bool = True  # start the DBOS runtime inside the API process
    log_level: str = "INFO"

    # Databases. DATABASE_URL = table owner (migrations only). APP_DATABASE_URL = non-superuser,
    # RLS-subject role used by the API and workers.
    database_url: str = "postgresql+psycopg://tenderline:tenderline@localhost:5433/tenderline"
    app_database_url: str = "postgresql+psycopg://tenderline_app:tenderline_app@localhost:5433/tenderline"
    app_db_password: str = "tenderline_app"
    dbos_system_database_url: str = "postgresql://tenderline:tenderline@localhost:5433/tenderline_dbos"
    # Connection pool of the app database. The defaults suit a normal host; a 512 MB host wants a few connections.
    db_pool_size: int = Field(default=10, ge=1)
    db_max_overflow: int = Field(default=20, ge=0)
    # DBOS options for hosts that cannot give it the defaults. Left unset, DBOS behaves exactly as before.
    dbos_use_listen_notify: bool = True  # False = poll instead of LISTEN/NOTIFY (needed behind a transaction pooler)
    dbos_sys_db_pool_size: int | None = Field(default=None, ge=1)  # None = DBOS default

    # Serve the built web app from this directory, on the same origin as the API. Empty (the default) = the API
    # only; Caddy serves the web app in the compose stacks. See render/README.md.
    serve_web_dir: str = ""

    # Auth
    jwt_secret: str = "dev-only-change-me-dev-only-change-me"
    jwt_ttl_minutes: int = 60
    github_client_id: str = ""
    github_client_secret: str = ""
    github_redirect_uri: str = "http://localhost:5173/auth/callback"

    # Rate limiting (per organisation, fixed window)
    rate_limit_per_minute: int = 600

    # TED
    ted_base_url: str = "https://api.ted.europa.eu"
    ted_page_size: int = Field(default=100, le=250)
    ted_max_requests_per_minute: int = 120  # hard ceiling is 700/min; stay far below
    ted_country: str = "IRL"
    ted_extra_cpv_prefixes: str = ""  # comma separated, e.g. "72,48"
    ted_lookback_days: int = 7
    ingest_cron: str = "0 6 * * *"
    ingest_max_pages: int = 40

    # Opportunity workflows wake at least this often (keeps shutdown prompt and the step history small)
    opportunity_max_wait_seconds: int = 3600

    # A saved-search backfill auto-qualifies at most this many matches (newest first); the rest stay matched and can
    # be qualified on demand (POST .../matches/{id}/qualify). Keeps one broad search from flooding the LLM queue.
    backfill_qualify_limit: int = 50

    # Retention, applied by the daily cleanup workflow. The audit log and notice versions are kept forever.
    workflow_retention_days: int = 30
    idempotency_key_retention_days: int = 7

    # Queues
    enrich_queue_concurrency: int = 4
    qualify_queue_concurrency: int = 2

    # LLM
    llm_provider_chain: str = "fake"  # comma separated: groq,gemini,ollama,fake
    llm_timeout_seconds: float = 60.0
    prompt_version: str = "qualify-v2"
    groq_api_key: str = ""
    groq_base_url: str = "https://api.groq.com/openai/v1"
    groq_model: str = "llama-3.3-70b-versatile"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2"
    # Price in USD per million tokens, per provider (from the provider's price list). Local providers cost 0.
    groq_cost_per_mtok_in: float = 0.0
    groq_cost_per_mtok_out: float = 0.0
    gemini_cost_per_mtok_in: float = 0.0
    gemini_cost_per_mtok_out: float = 0.0

    # Observability
    otel_enabled: bool = True
    otel_exporter_otlp_endpoint: str = ""
    otel_exporter_otlp_headers: str = ""
    otel_exporter_otlp_protocol: str = "http/protobuf"
    langfuse_public_key: str = ""
    langfuse_secret_key: str = ""
    langfuse_host: str = "https://cloud.langfuse.com"

    # Metadata endpoint
    contact_email: str = "ops@example.invalid"

    @property
    def is_dev(self) -> bool:
        return self.env == "dev"

    @property
    def llm_chain(self) -> list[str]:
        return [p.strip() for p in self.llm_provider_chain.split(",") if p.strip()]

    @property
    def extra_cpv_prefixes(self) -> list[str]:
        return [p.strip() for p in self.ted_extra_cpv_prefixes.split(",") if p.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
