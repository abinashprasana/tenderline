"""Application settings. Every variable is documented in .env.example and SETUP.md."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    env: str = "dev"  # dev | prod | test
    service_name: str = "tenderline-api"
    log_level: str = "INFO"

    # Databases. DATABASE_URL = table owner (migrations only). APP_DATABASE_URL = non-superuser,
    # RLS-subject role used by the API and workers.
    database_url: str = "postgresql+psycopg://tenderline:tenderline@localhost:5433/tenderline"
    app_database_url: str = "postgresql+psycopg://tenderline_app:tenderline_app@localhost:5433/tenderline"
    app_db_password: str = "tenderline_app"
    dbos_system_database_url: str = "postgresql://tenderline:tenderline@localhost:5433/tenderline_dbos"

    # Auth
    jwt_secret: str = "dev-only-change-me-dev-only-change-me"
    jwt_ttl_minutes: int = 60
    github_client_id: str = ""
    github_client_secret: str = ""
    github_redirect_uri: str = "http://localhost:8000/v1/auth/github/callback"

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

    # Queues
    enrich_queue_concurrency: int = 4
    qualify_queue_concurrency: int = 2

    # LLM
    llm_provider_chain: str = "fake"  # comma separated: groq,gemini,ollama,fake
    llm_timeout_seconds: float = 60.0
    prompt_version: str = "qualify-v1"
    groq_api_key: str = ""
    groq_base_url: str = "https://api.groq.com/openai/v1"
    groq_model: str = "llama-3.3-70b-versatile"
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2"
    # Cost per 1M tokens in USD (input,output) per provider; 0 for local/fake.
    llm_cost_per_mtok_in: float = 0.0
    llm_cost_per_mtok_out: float = 0.0

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
