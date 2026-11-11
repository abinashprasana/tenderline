# SETUP: what you must create yourself

Nothing here is needed to run locally (`docker compose up`). These are for production and optional features. Every variable is also in `.env.example`.

| Account / secret | Needed for | Exact variable(s) | How |
|---|---|---|---|
| **GitHub OAuth app** | Login (`GET /v1/auth/github/login`) | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_REDIRECT_URI` | GitHub > Settings > Developer settings > OAuth Apps > New. Callback URL must equal `GITHUB_REDIRECT_URI` (`https://<DOMAIN>/v1/auth/github/callback`). |
| **JWT secret** | Signing tokens | `JWT_SECRET` | `openssl rand -hex 32`. The app refuses to start with `ENV=prod` and the default. |
| **Database passwords** | Production Postgres | `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` | Any strong values. `APP_DB_PASSWORD` is the non-superuser role subject to row-level security. |
| **Oracle Cloud** | Terraform, VM, backups | `TF_VAR`s or `terraform/terraform.tfvars`: `tenancy_ocid`, `user_ocid`, `fingerprint`, `private_key_path`, `compartment_ocid`, `region`, `ssh_public_key`, `admin_cidr` | Create an API key for your user (OCI console > Profile > API keys). Then `cd terraform && terraform init && terraform plan`. **Apply is yours to run.** |
| **OCI Customer Secret Key** (S3-compatible) | Uploading backups | `OCI_S3_ENDPOINT` (Terraform output `s3_compat_endpoint`), `OCI_S3_BUCKET` (`backup_bucket`), `OCI_S3_ACCESS_KEY`, `OCI_S3_SECRET_KEY`, `OCI_REGION` | Profile > Customer secret keys. Without them backups stay on the VM volume only. |
| **DNS + domain** | TLS via Caddy | `DOMAIN` | Point an A record at the Terraform `public_ip`. |
| **Groq key** | LLM provider | `GROQ_API_KEY`, `GROQ_MODEL`, add `groq` to `LLM_PROVIDER_CHAIN` | console.groq.com |
| **Gemini key** | LLM provider | `GEMINI_API_KEY`, `GEMINI_MODEL`, add `gemini` to `LLM_PROVIDER_CHAIN` | Google AI Studio |
| **LLM pricing** | Cost tracking | `GROQ_COST_PER_MTOK_IN`, `GROQ_COST_PER_MTOK_OUT`, `GEMINI_COST_PER_MTOK_IN`, `GEMINI_COST_PER_MTOK_OUT` | USD per million tokens, from each provider's price page. Left at 0, cost is recorded as 0. |
| **Grafana Cloud** | Hosted telemetry | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` (`Authorization=Basic <base64 instanceId:token>`) | Grafana Cloud > your stack > OpenTelemetry (OTLP). Set only these two variables; no code or collector change. |
| **Langfuse** (optional) | LLM traces | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` | Off when keys are empty. |
| **GitHub Actions secrets** | Deploy job | `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` | Repo > Settings > Secrets. The deploy job is skipped unless all three exist. Create a `production` environment if you want approvals. |

## Things to know before production

- The app defaults to `ENV=prod`. The dev token endpoint exists only when you set `ENV=dev`.
- With `ENV=prod`, at least one LLM provider in `LLM_PROVIDER_CHAIN` needs a key, or the app refuses to qualify notices. Add `fake` or `ollama` to the chain on purpose if that is what you want.
- Set `APP_VERSION` to the release you deploy (the CI uses the git SHA tag). Open opportunities move to the new release within 10 minutes.

## First production deploy

1. `terraform apply` (after reviewing the plan), note `public_ip`, create the DNS record.
2. SSH to the VM, create `/opt/tenderline/.env` with the variables above (`DOMAIN`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `JWT_SECRET`, `TENDERLINE_IMAGE=ghcr.io/<owner>/tenderline:latest`, ...).
3. Push to `main`: CI builds the multi-arch image and deploys. Or run `docker compose -f docker-compose.prod.yml --env-file .env up -d` by hand.

## Not verified without your credentials

The Groq, Gemini, Ollama, Langfuse and Grafana Cloud paths, the OCI apply, the SSH deploy and TLS issuance have not been exercised against the real services. The request/response formats follow each provider's public API and are unit-tested only against mocked HTTP.
