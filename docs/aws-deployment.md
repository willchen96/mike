# AWS Deployment Guide

Single-region, single-environment, single-VPC production deployment of Mike on AWS using ECS Fargate, RDS Postgres, S3, Cognito, Bedrock, SES, and ALB. Images are pulled directly from `ghcr.io` — no ECR.

Audience: an AWS engineer who already knows IAM, VPC, ALB, ECS, and RDS. This guide focuses on what's specific to **this app** and skips the basics. Where multiple equivalent paths exist (console vs. CLI vs. IaC), CLI examples are given because they're copy-pasteable and unambiguous; translate to your preferred IaC.

---

## Contents

1. [Architecture](#1-architecture)
2. [Prerequisites](#2-prerequisites)
3. [Conventions](#3-conventions)
4. [Networking (VPC, subnets, security groups)](#4-networking)
5. [Cognito User Pool + SES](#5-cognito--ses)
6. [RDS Postgres](#6-rds-postgres)
7. [S3 bucket](#7-s3-bucket)
8. [Bedrock model access](#8-bedrock-model-access)
9. [ACM + Route 53](#9-acm--route-53)
10. [Secrets Manager](#10-secrets-manager)
11. [IAM (task role + execution role)](#11-iam-roles)
12. [ECS cluster + log groups](#12-ecs-cluster--logs)
13. [Application Load Balancers + target groups](#13-application-load-balancers)
14. [ECS task definitions + services](#14-ecs-task-definitions--services)
15. [Database migrations (one-shot task)](#15-database-migrations)
16. [Smoke test](#16-smoke-test)
17. [Day-2 operations](#17-day-2-operations)
18. [Observability](#18-observability)
19. [Cost estimate](#19-cost-estimate)
20. [Security checklist](#20-security-checklist)
21. [Troubleshooting](#21-troubleshooting)
22. [Appendix A — Optional improvements](#appendix-a--optional-improvements)
23. [Appendix B — Private GHCR images](#appendix-b--private-ghcr-images)

---

## 1. Architecture

```
                          Route 53 (mikeoss.com)
                          /                    \
                  app.mikeoss.com         api.mikeoss.com
                       │                         │
                       ▼                         ▼
                 ALB (public)                ALB (public)
                       │                         │
              [HTTPS:443, idle 120s]    [HTTPS:443, idle 180s]
                       │                         │
                       ▼                         ▼
                Frontend TG (3000)        Backend TG (3001)
                       │                         │
                       ▼                         ▼
              ┌────────────────────────────────────────┐
              │   ECS Fargate cluster (mike-prod)      │
              │                                        │
              │   mike-frontend (Next.js, port 3000)   │
              │   mike-backend  (Express, port 3001)   │
              └────────────────────────────────────────┘
                       │                         │
                       │                         ├──► RDS Postgres (private)
                       │                         ├──► S3 bucket (regional endpoint or gateway VPCe)
                       │                         ├──► Bedrock Runtime (regional)
                       │                         ├──► Cognito Identity Provider
                       │                         └──► Secrets Manager
                       │
                       └──► (browser → api.mikeoss.com directly; no proxy)
```

Two ALBs (one per app) is the cleanest fit because:

- The frontend reads `NEXT_PUBLIC_API_BASE_URL` and the browser calls the backend directly. CORS on the backend is configured by `FRONTEND_URL`, so the two hostnames need to be distinct.
- The backend streams Bedrock responses as Server-Sent Events; you'll bump the backend ALB's idle timeout. The frontend doesn't need that.
- Path-based routing on a single ALB also works, but means one cert SAN, mixed log streams, and shared idle timeouts. Two ALBs is ~$23/month extra and worth it.

The frontend talks to the backend over the public internet (browser → `api.mikeoss.com`). Inter-task chatter inside the VPC is minimal.

### Per-task footprint

| Service | vCPU | Memory | Notes |
|---|---|---|---|
| `mike-frontend` | 0.25 | 512 MB | Next.js standalone is light. |
| `mike-backend` | 0.5 | 2048 MB | Uploads up to 100 MB are buffered in memory (`multer.memoryStorage()`), and LibreOffice spawns to convert DOC/DOCX. 1 GB is the floor; 2 GB gives headroom for concurrent uploads + a LibreOffice subprocess. |

Run **2 tasks per service** minimum so a single-AZ outage or task replacement doesn't blip you offline.

---

## 2. Prerequisites

You'll need:

- An AWS account with admin or equivalent broad permissions for the bootstrap.
- The AWS CLI v2, authenticated to your target account/region.
- A registered domain you control (this guide uses `mikeoss.com` with subdomains `app.` and `api.`).
- Bedrock access requested and approved for the Claude model families you intend to use — see [§8](#8-bedrock-model-access).
- A GitHub account if you'll later customize CI to push tags. The image pulls themselves don't need credentials as long as the upstream `ghcr.io/<owner>/mike-{frontend,backend}` repos are public (Appendix B covers the private case).

You do **not** need:

- ECR (we pull from ghcr.io).
- A NAT Gateway, strictly. Fargate tasks in private subnets need outbound internet to reach `ghcr.io`, Bedrock, Cognito, etc. You have two choices:
  - **NAT Gateway** (simplest, ~$32/month per AZ + data). This guide uses one NAT in one AZ.
  - **VPC endpoints** for everything the tasks reach (ECR isn't in play; you'd need endpoints for S3, Bedrock, Cognito-IDP, Secrets Manager, CloudWatch Logs, KMS, and you still can't reach ghcr.io without NAT or a public subnet). Not worth it unless you have a strict no-NAT policy.
- A separate SES domain — the same root domain works.

---

## 3. Conventions

Throughout this guide, replace these placeholders:

```bash
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export DOMAIN=mikeoss.com
export APP_FQDN=app.mikeoss.com
export API_FQDN=api.mikeoss.com
export PROJECT=mike
export ENV=prod
export GHCR_OWNER=amaingot          # ghcr.io/<owner>/mike-{frontend,backend}
export IMAGE_TAG=latest              # pin to a sha-<commit> tag for production
```

Resource naming pattern: `${PROJECT}-${ENV}-<purpose>` (e.g., `mike-prod-tasks-sg`, `mike-prod-rds`).

---

## 4. Networking

A single VPC, two AZs, four subnets, one NAT.

### VPC + subnets

```bash
aws ec2 create-vpc \
  --cidr-block 10.40.0.0/16 \
  --tag-specifications "ResourceType=vpc,Tags=[{Key=Name,Value=${PROJECT}-${ENV}-vpc}]"
# Note the VpcId returned; export it as VPC_ID.

aws ec2 modify-vpc-attribute --vpc-id $VPC_ID --enable-dns-hostnames
```

Create two public and two private subnets across two AZs:

| Name | CIDR | AZ | Purpose |
|---|---|---|---|
| `mike-prod-public-a` | 10.40.0.0/20 | us-east-1a | ALB, NAT |
| `mike-prod-public-b` | 10.40.16.0/20 | us-east-1b | ALB |
| `mike-prod-private-a` | 10.40.32.0/20 | us-east-1a | ECS tasks, RDS |
| `mike-prod-private-b` | 10.40.48.0/20 | us-east-1b | ECS tasks, RDS |

```bash
# Public a
aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.40.0.0/20 \
  --availability-zone ${AWS_REGION}a \
  --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=${PROJECT}-${ENV}-public-a}]"
# Repeat for the other three.
```

Set `--map-public-ip-on-launch` on both public subnets:

```bash
aws ec2 modify-subnet-attribute --subnet-id $PUB_A --map-public-ip-on-launch
aws ec2 modify-subnet-attribute --subnet-id $PUB_B --map-public-ip-on-launch
```

### Internet gateway + NAT

```bash
# IGW
aws ec2 create-internet-gateway \
  --tag-specifications "ResourceType=internet-gateway,Tags=[{Key=Name,Value=${PROJECT}-${ENV}-igw}]"
aws ec2 attach-internet-gateway --vpc-id $VPC_ID --internet-gateway-id $IGW_ID

# Elastic IP + NAT in public-a (single-AZ NAT keeps cost down)
aws ec2 allocate-address --domain vpc
aws ec2 create-nat-gateway --subnet-id $PUB_A --allocation-id $EIP_ALLOC_ID \
  --tag-specifications "ResourceType=natgateway,Tags=[{Key=Name,Value=${PROJECT}-${ENV}-nat}]"
```

### Route tables

- **Public RT**: `0.0.0.0/0 → IGW`, associate both public subnets.
- **Private RT**: `0.0.0.0/0 → NAT`, associate both private subnets.

```bash
# Public RT
aws ec2 create-route-table --vpc-id $VPC_ID \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=${PROJECT}-${ENV}-public-rt}]"
aws ec2 create-route --route-table-id $PUB_RT --destination-cidr-block 0.0.0.0/0 --gateway-id $IGW_ID
aws ec2 associate-route-table --route-table-id $PUB_RT --subnet-id $PUB_A
aws ec2 associate-route-table --route-table-id $PUB_RT --subnet-id $PUB_B

# Private RT
aws ec2 create-route-table --vpc-id $VPC_ID \
  --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=${PROJECT}-${ENV}-private-rt}]"
aws ec2 create-route --route-table-id $PRIV_RT --destination-cidr-block 0.0.0.0/0 --nat-gateway-id $NAT_ID
aws ec2 associate-route-table --route-table-id $PRIV_RT --subnet-id $PRIV_A
aws ec2 associate-route-table --route-table-id $PRIV_RT --subnet-id $PRIV_B
```

### VPC endpoints (recommended)

Cuts NAT bytes for the chatty AWS APIs:

- **S3 gateway endpoint** — free, attaches to the private RT. Highly recommended (every file upload/download is going through here).
- **DynamoDB gateway endpoint** — not used by this app; skip.
- Interface endpoints for `secretsmanager`, `logs`, `bedrock-runtime` — costs ~$7/month each but reduce NAT egress for hot paths. Optional.

```bash
aws ec2 create-vpc-endpoint \
  --vpc-id $VPC_ID --service-name com.amazonaws.${AWS_REGION}.s3 \
  --route-table-ids $PRIV_RT \
  --vpc-endpoint-type Gateway
```

### Security groups

Create four SGs:

| SG | Inbound | Outbound |
|---|---|---|
| `mike-prod-alb-frontend-sg` | 80/443 from 0.0.0.0/0 | all |
| `mike-prod-alb-backend-sg` | 80/443 from 0.0.0.0/0 | all |
| `mike-prod-tasks-sg` | 3000 from `alb-frontend-sg`; 3001 from `alb-backend-sg` | all |
| `mike-prod-rds-sg` | 5432 from `tasks-sg` | none |

```bash
# Tasks SG
aws ec2 create-security-group --group-name ${PROJECT}-${ENV}-tasks-sg \
  --description "ECS tasks" --vpc-id $VPC_ID

aws ec2 authorize-security-group-ingress --group-id $TASKS_SG \
  --protocol tcp --port 3000 --source-group $ALB_FRONTEND_SG
aws ec2 authorize-security-group-ingress --group-id $TASKS_SG \
  --protocol tcp --port 3001 --source-group $ALB_BACKEND_SG

# RDS SG
aws ec2 create-security-group --group-name ${PROJECT}-${ENV}-rds-sg \
  --description "RDS Postgres" --vpc-id $VPC_ID
aws ec2 authorize-security-group-ingress --group-id $RDS_SG \
  --protocol tcp --port 5432 --source-group $TASKS_SG
```

By default new SGs have an open egress rule (0.0.0.0/0 all) — leave that.

---

## 5. Cognito + SES

The app uses Cognito as the only identity provider. The backend's `/user/delete-account` route calls `cognito-idp:AdminDeleteUser` against the same pool. There is no email sent **by the app** — all transactional email (signup confirmation, password reset) flows through Cognito → SES.

### 5a. Verify the SES identity

```bash
# Verify the domain
aws ses verify-domain-identity --domain $DOMAIN --region $AWS_REGION

# Returns a TXT record value. Add it under _amazonses.<DOMAIN> in Route 53.
# Also add the three CNAME DKIM records that SES generates:
aws ses verify-domain-dkim --domain $DOMAIN --region $AWS_REGION
```

If your account is in **SES sandbox**, signup confirmation emails to unverified addresses will silently disappear. Either:

- Verify every test address up front (`aws ses verify-email-identity --email-address …`), or
- Open a quota-increase ticket to leave the sandbox before going live.

Add a `no-reply@${DOMAIN}` verified identity (or use the domain identity and any sender on it).

### 5b. Create the Cognito User Pool

```bash
aws cognito-idp create-user-pool \
  --pool-name ${PROJECT}-${ENV} \
  --policies 'PasswordPolicy={MinimumLength=10,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false}' \
  --auto-verified-attributes email \
  --username-attributes email \
  --account-recovery-setting 'RecoveryMechanisms=[{Priority=1,Name=verified_email}]' \
  --schema 'Name=email,Required=true,Mutable=true' \
  --email-configuration "EmailSendingAccount=DEVELOPER,From=no-reply@${DOMAIN},SourceArn=arn:aws:ses:${AWS_REGION}:${ACCOUNT_ID}:identity/${DOMAIN}"
# Capture UserPool.Id as COGNITO_USER_POOL_ID.
```

Notes:

- `EmailSendingAccount=DEVELOPER` is what wires Cognito to your SES identity. `COGNITO_DEFAULT` is the throttled built-in sender (50 emails/day) — fine for a smoke test, not for production.
- Username = email simplifies signup flow and matches what the frontend expects.

### 5c. Create the app client

```bash
aws cognito-idp create-user-pool-client \
  --user-pool-id $COGNITO_USER_POOL_ID \
  --client-name ${PROJECT}-${ENV}-web \
  --no-generate-secret \
  --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH ALLOW_USER_SRP_AUTH \
  --prevent-user-existence-errors ENABLED \
  --refresh-token-validity 30 \
  --token-validity-units '{"AccessToken":"hours","IdToken":"hours","RefreshToken":"days"}' \
  --access-token-validity 1 \
  --id-token-validity 1
# Capture UserPoolClient.ClientId as COGNITO_CLIENT_ID.
```

`--no-generate-secret` is required for browser-side SDK use.

---

## 6. RDS Postgres

A single instance is fine for v1. Multi-AZ is the cheap upgrade when you're ready.

### Subnet group + parameter group

```bash
aws rds create-db-subnet-group \
  --db-subnet-group-name ${PROJECT}-${ENV} \
  --db-subnet-group-description "Mike private subnets" \
  --subnet-ids $PRIV_A $PRIV_B
```

Force-TLS parameter group (the app already connects with `ssl: true` in production, so this enforces it server-side too):

```bash
aws rds create-db-parameter-group \
  --db-parameter-group-name ${PROJECT}-${ENV}-pg16 \
  --db-parameter-group-family postgres16 \
  --description "Mike Postgres 16"

aws rds modify-db-parameter-group \
  --db-parameter-group-name ${PROJECT}-${ENV}-pg16 \
  --parameters "ParameterName=rds.force_ssl,ParameterValue=1,ApplyMethod=immediate"
```

### Create the instance

```bash
# Generate and store the master password in Secrets Manager up front.
DB_MASTER_PASSWORD=$(aws secretsmanager get-random-password \
  --exclude-characters '"@/\' --password-length 40 --query RandomPassword --output text)

aws rds create-db-instance \
  --db-instance-identifier ${PROJECT}-${ENV} \
  --db-instance-class db.t4g.small \
  --engine postgres --engine-version 16.4 \
  --allocated-storage 50 --storage-type gp3 --storage-encrypted \
  --master-username mike --master-user-password "$DB_MASTER_PASSWORD" \
  --db-name mike \
  --vpc-security-group-ids $RDS_SG \
  --db-subnet-group-name ${PROJECT}-${ENV} \
  --db-parameter-group-name ${PROJECT}-${ENV}-pg16 \
  --backup-retention-period 7 \
  --preferred-backup-window "08:00-09:00" \
  --preferred-maintenance-window "sun:09:30-sun:10:30" \
  --auto-minor-version-upgrade \
  --deletion-protection \
  --no-publicly-accessible \
  --copy-tags-to-snapshot
```

When it reaches `available`, grab the endpoint:

```bash
DB_HOST=$(aws rds describe-db-instances --db-instance-identifier ${PROJECT}-${ENV} \
  --query 'DBInstances[0].Endpoint.Address' --output text)
DATABASE_URL="postgres://mike:${DB_MASTER_PASSWORD}@${DB_HOST}:5432/mike?sslmode=require"
```

Sizing guidance:

- `db.t4g.small` (2 vCPU burstable, 2 GB RAM) is fine until ~50 concurrent users.
- The app does no heavy SQL aggregation; you'll be bottlenecked on Bedrock long before Postgres.
- Storage: 50 GB gp3 is generous (the schema stores message + document metadata, never the documents themselves — those go to S3).

### Multi-AZ upgrade later

```bash
aws rds modify-db-instance --db-instance-identifier ${PROJECT}-${ENV} --multi-az --apply-immediately
```

---

## 7. S3 bucket

One bucket, server-side encryption, versioning on, all public access blocked.

```bash
BUCKET=${PROJECT}-${ENV}-files-${ACCOUNT_ID}

aws s3api create-bucket --bucket $BUCKET --region $AWS_REGION
# (For regions other than us-east-1, add --create-bucket-configuration LocationConstraint=$AWS_REGION)

aws s3api put-bucket-encryption --bucket $BUCKET \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-bucket-versioning --bucket $BUCKET \
  --versioning-configuration Status=Enabled

aws s3api put-public-access-block --bucket $BUCKET \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

### CORS

The frontend renders documents inline and downloads them via S3 presigned URLs (`getSignedUrl` in `backend/src/lib/storage.ts`). The browser fetches those URLs directly from S3, so the bucket must allow the frontend origin:

```bash
cat > /tmp/cors.json <<EOF
{
  "CORSRules": [{
    "AllowedOrigins": ["https://${APP_FQDN}"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Content-Type"],
    "MaxAgeSeconds": 3000
  }]
}
EOF
aws s3api put-bucket-cors --bucket $BUCKET --cors-configuration file:///tmp/cors.json
```

Only `GET` is needed — uploads go through the backend (`multer.memoryStorage()` → `PutObjectCommand`), not directly from the browser.

### Lifecycle (optional)

Documents are kept indefinitely by app design, but you almost certainly want to expire orphaned multipart uploads:

```bash
cat > /tmp/lifecycle.json <<EOF
{
  "Rules": [{
    "ID": "abort-incomplete-multipart",
    "Status": "Enabled",
    "Filter": {},
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 7 }
  }]
}
EOF
aws s3api put-bucket-lifecycle-configuration --bucket $BUCKET --lifecycle-configuration file:///tmp/lifecycle.json
```

---

## 8. Bedrock model access

Bedrock model access is **opt-in per model family per region**. Without this, every Claude call returns `AccessDeniedException`.

1. Go to Bedrock → Model access in the AWS console for `$AWS_REGION`.
2. Request access for **Anthropic Claude** (covers all the Claude families the app uses).
3. Request access for any other providers you intend to expose (Cohere, Meta, etc. — the app currently only ships Claude through Bedrock).

Confirmed models in use, by id (`backend/src/lib/llm/claude.ts`):

| Logical | Bedrock model id |
|---|---|
| `claude-opus-4-7` | `anthropic.claude-opus-4-7-v1:0` |
| `claude-sonnet-4-6` | `anthropic.claude-sonnet-4-6-v1:0` |
| `claude-haiku-4-5` | `anthropic.claude-haiku-4-5-v1:0` |

Approval is usually instant for Anthropic. There is no Terraform/CLI path for the access toggle today — it must be done in the console (or via the AWS Marketplace subscription API, which the console wraps).

Check it's live:

```bash
aws bedrock-runtime invoke-model \
  --region $AWS_REGION \
  --model-id anthropic.claude-haiku-4-5-v1:0 \
  --content-type application/json \
  --accept application/json \
  --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' \
  /tmp/bedrock-test.json && cat /tmp/bedrock-test.json
```

---

## 9. ACM + Route 53

### Certificates

Two certs in the same region as the ALBs (ALB cannot use a CloudFront/us-east-1 cert unless the ALB itself is in us-east-1):

```bash
aws acm request-certificate --domain-name $APP_FQDN --validation-method DNS
aws acm request-certificate --domain-name $API_FQDN --validation-method DNS
```

Add the two `_acme-challenge.*` CNAMEs to Route 53. ACM will move to `ISSUED` within a few minutes.

Alternatively, request a single wildcard `*.${DOMAIN}` cert and share it between both ALBs.

### Route 53 records

Created **after** the ALBs exist (you'll need their DNS names). See [§13](#13-application-load-balancers).

---

## 10. Secrets Manager

Store all sensitive env values here. ECS task definitions reference them via the `secrets` block and the execution role gets `secretsmanager:GetSecretValue` on each ARN.

Required secrets:

| Secret name | Contents | Notes |
|---|---|---|
| `mike/prod/database-url` | `postgres://mike:…@…:5432/mike?sslmode=require` | Plaintext string. |
| `mike/prod/download-signing-secret` | 32-byte hex | Backend signs S3 redirect URLs. `openssl rand -hex 32`. |
| `mike/prod/user-api-keys-encryption-secret` | long random string | AES-256-GCM key for per-user provider keys stored in Postgres. `openssl rand -base64 48`. |
| `mike/prod/gemini-api-key` *(optional)* | Google AI Studio key | Only if you want a server-wide Gemini key. Users can still bring their own. |
| `mike/prod/openai-api-key` *(optional)* | OpenAI key | Same caveat. |

```bash
aws secretsmanager create-secret --name mike/prod/database-url \
  --secret-string "$DATABASE_URL"

aws secretsmanager create-secret --name mike/prod/download-signing-secret \
  --secret-string "$(openssl rand -hex 32)"

aws secretsmanager create-secret --name mike/prod/user-api-keys-encryption-secret \
  --secret-string "$(openssl rand -base64 48)"
```

**Do not rotate `user-api-keys-encryption-secret` without a re-encryption migration.** Anything encrypted with it (user-stored OpenAI/Gemini keys) becomes unreadable. Treat it as a long-lived secret. The download signing secret can be rotated freely; outstanding signed URLs become invalid (typically <1 hour TTL).

---

## 11. IAM roles

Two roles per service: an **execution role** (used by ECS itself to pull config) and a **task role** (used by your app code).

### Execution role (shared by both services)

Standard `ecsTaskExecutionRole` with the AWS-managed `AmazonECSTaskExecutionRolePolicy`, **plus** explicit grants for each Secrets Manager secret you reference.

```bash
cat > /tmp/exec-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF

aws iam create-role --role-name mike-prod-exec --assume-role-policy-document file:///tmp/exec-trust.json
aws iam attach-role-policy --role-name mike-prod-exec \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

cat > /tmp/exec-secrets.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["secretsmanager:GetSecretValue"],
    "Resource": [
      "arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:mike/prod/*"
    ]
  }]
}
EOF
aws iam put-role-policy --role-name mike-prod-exec \
  --policy-name mike-prod-secrets-read --policy-document file:///tmp/exec-secrets.json
```

### Frontend task role

The Next.js frontend currently makes no AWS API calls — it gets Cognito tokens client-side and posts them to the backend. Give it an empty role (no policies) for blast-radius hygiene:

```bash
aws iam create-role --role-name mike-prod-frontend-task --assume-role-policy-document file:///tmp/exec-trust.json
```

### Backend task role

This is the one with real grants:

```bash
cat > /tmp/backend-task-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "S3Objects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/*"
    },
    {
      "Sid": "Bedrock",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": [
        "arn:aws:bedrock:${AWS_REGION}::foundation-model/anthropic.claude-opus-4-7-v1:0",
        "arn:aws:bedrock:${AWS_REGION}::foundation-model/anthropic.claude-sonnet-4-6-v1:0",
        "arn:aws:bedrock:${AWS_REGION}::foundation-model/anthropic.claude-haiku-4-5-v1:0"
      ]
    },
    {
      "Sid": "CognitoAdminDeleteSelf",
      "Effect": "Allow",
      "Action": ["cognito-idp:AdminDeleteUser"],
      "Resource": "arn:aws:cognito-idp:${AWS_REGION}:${ACCOUNT_ID}:userpool/${COGNITO_USER_POOL_ID}"
    }
  ]
}
EOF

aws iam create-role --role-name mike-prod-backend-task --assume-role-policy-document file:///tmp/exec-trust.json
aws iam put-role-policy --role-name mike-prod-backend-task \
  --policy-name mike-prod-backend --policy-document file:///tmp/backend-task-policy.json
```

Notes:

- `bedrock:InvokeModel*` is scoped to model ARNs to match the README's threat model. Don't widen to `*` unless you intend to expose more models.
- The README mentions `ses:SendEmail` in the prerequisites list. That's a vestige — the current source does not send any email from the application code. SES is only invoked by **Cognito** on the user pool's behalf, which uses a service-linked identity, not your task role. Skip the SES grant unless you reintroduce server-side transactional email.
- If you later add image-pulls from a private GHCR repo, you'll grant Secrets Manager read on the credential secret to the **execution role**, not the task role — see [Appendix B](#appendix-b--private-ghcr-images).

---

## 12. ECS cluster + logs

### Cluster

```bash
aws ecs create-cluster --cluster-name mike-prod \
  --capacity-providers FARGATE FARGATE_SPOT \
  --default-capacity-provider-strategy capacityProvider=FARGATE,weight=1
```

Keep `FARGATE_SPOT` listed so you can opt individual non-critical services into it later. For both production services here, stay on on-demand FARGATE.

### CloudWatch log groups

```bash
aws logs create-log-group --log-group-name /ecs/mike-prod/frontend
aws logs create-log-group --log-group-name /ecs/mike-prod/backend
aws logs put-retention-policy --log-group-name /ecs/mike-prod/frontend --retention-in-days 30
aws logs put-retention-policy --log-group-name /ecs/mike-prod/backend --retention-in-days 30
```

30 days is a reasonable default. Bump to 90 if you're chasing intermittent prod bugs.

---

## 13. Application Load Balancers

Two internet-facing ALBs, each across both public subnets, each with its own SG.

```bash
# Frontend ALB
FRONTEND_ALB_ARN=$(aws elbv2 create-load-balancer \
  --name mike-prod-frontend-alb \
  --subnets $PUB_A $PUB_B \
  --security-groups $ALB_FRONTEND_SG \
  --type application --ip-address-type ipv4 \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

# Backend ALB
BACKEND_ALB_ARN=$(aws elbv2 create-load-balancer \
  --name mike-prod-backend-alb \
  --subnets $PUB_A $PUB_B \
  --security-groups $ALB_BACKEND_SG \
  --type application --ip-address-type ipv4 \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)
```

### Backend ALB idle timeout

Bedrock streaming responses can run for tens of seconds. The default 60s idle timeout will kill long streams. Bump to **180s** on the backend ALB (the frontend doesn't need this):

```bash
aws elbv2 modify-load-balancer-attributes \
  --load-balancer-arn $BACKEND_ALB_ARN \
  --attributes Key=idle_timeout.timeout_seconds,Value=180
```

### Target groups

Both use IP target type (required for Fargate).

```bash
# Frontend TG (port 3000, health check '/')
FRONTEND_TG_ARN=$(aws elbv2 create-target-group \
  --name mike-prod-frontend-tg \
  --protocol HTTP --port 3000 --vpc-id $VPC_ID \
  --target-type ip \
  --health-check-path / --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
  --matcher HttpCode=200-399 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# Backend TG (port 3001, health check '/health')
BACKEND_TG_ARN=$(aws elbv2 create-target-group \
  --name mike-prod-backend-tg \
  --protocol HTTP --port 3001 --vpc-id $VPC_ID \
  --target-type ip \
  --health-check-path /health --health-check-interval-seconds 15 \
  --healthy-threshold-count 2 --unhealthy-threshold-count 3 \
  --matcher HttpCode=200 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# Increase deregistration delay slightly so in-flight streams don't get cut on deploys
aws elbv2 modify-target-group-attributes --target-group-arn $BACKEND_TG_ARN \
  --attributes Key=deregistration_delay.timeout_seconds,Value=60
```

### Listeners

Each ALB gets HTTPS:443 (terminates the cert) and HTTP:80 (301 → HTTPS):

```bash
# Frontend HTTPS
aws elbv2 create-listener --load-balancer-arn $FRONTEND_ALB_ARN \
  --protocol HTTPS --port 443 \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
  --certificates CertificateArn=$APP_CERT_ARN \
  --default-actions Type=forward,TargetGroupArn=$FRONTEND_TG_ARN

# Frontend HTTP redirect
aws elbv2 create-listener --load-balancer-arn $FRONTEND_ALB_ARN \
  --protocol HTTP --port 80 \
  --default-actions 'Type=redirect,RedirectConfig={Protocol=HTTPS,Port=443,StatusCode=HTTP_301}'

# Repeat for the backend ALB with $API_CERT_ARN and $BACKEND_TG_ARN.
```

### Route 53

Alias records pointing at each ALB:

```bash
# Get the ALBs' canonical hosted zone ids
aws elbv2 describe-load-balancers --load-balancer-arns $FRONTEND_ALB_ARN \
  --query 'LoadBalancers[0].[DNSName,CanonicalHostedZoneId]' --output text
# Use the values to create A/AAAA alias records in Route 53.
```

In the console: Route 53 → Hosted zones → `${DOMAIN}` → Create record → `app` → A → Alias to ALB → pick the frontend ALB. Repeat for `api` → backend ALB.

---

## 14. ECS task definitions + services

### Backend task definition

```bash
cat > /tmp/td-backend.json <<EOF
{
  "family": "mike-prod-backend",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/mike-prod-exec",
  "taskRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/mike-prod-backend-task",
  "runtimePlatform": { "operatingSystemFamily": "LINUX", "cpuArchitecture": "X86_64" },
  "containerDefinitions": [{
    "name": "backend",
    "image": "ghcr.io/${GHCR_OWNER}/mike-backend:${IMAGE_TAG}",
    "essential": true,
    "portMappings": [{ "containerPort": 3001, "protocol": "tcp" }],
    "healthCheck": {
      "command": ["CMD-SHELL", "wget -qO- http://localhost:3001/health >/dev/null || exit 1"],
      "interval": 30, "timeout": 5, "startPeriod": 30, "retries": 3
    },
    "environment": [
      { "name": "NODE_ENV", "value": "production" },
      { "name": "PORT", "value": "3001" },
      { "name": "AWS_REGION", "value": "${AWS_REGION}" },
      { "name": "BEDROCK_REGION", "value": "${AWS_REGION}" },
      { "name": "FRONTEND_URL", "value": "https://${APP_FQDN}" },
      { "name": "S3_BUCKET_NAME", "value": "${BUCKET}" },
      { "name": "COGNITO_USER_POOL_ID", "value": "${COGNITO_USER_POOL_ID}" },
      { "name": "COGNITO_CLIENT_ID", "value": "${COGNITO_CLIENT_ID}" },
      { "name": "TRUST_PROXY_HOPS", "value": "2" }
    ],
    "secrets": [
      { "name": "DATABASE_URL",                    "valueFrom": "arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:mike/prod/database-url" },
      { "name": "DOWNLOAD_SIGNING_SECRET",         "valueFrom": "arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:mike/prod/download-signing-secret" },
      { "name": "USER_API_KEYS_ENCRYPTION_SECRET", "valueFrom": "arn:aws:secretsmanager:${AWS_REGION}:${ACCOUNT_ID}:secret:mike/prod/user-api-keys-encryption-secret" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/mike-prod/backend",
        "awslogs-region": "${AWS_REGION}",
        "awslogs-stream-prefix": "ecs"
      }
    }
  }]
}
EOF
aws ecs register-task-definition --cli-input-json file:///tmp/td-backend.json
```

Key choices:

- **`TRUST_PROXY_HOPS=2`** — request goes browser → ALB → task. Express needs to skip two proxy hops to recover the client IP for rate limiting. The default in code is `1`, which is wrong behind ALB; setting it explicitly avoids the gotcha.
- **No `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`** — the task role provides credentials transparently. Set these only for local dev with MinIO. Leave `S3_ENDPOINT_URL` unset too, so the SDK uses the real S3.
- **No `COGNITO_JWKS_URI` or `COGNITO_ENDPOINT`** — the SDK resolves these from the pool id automatically. Setting them forces the local-dev path.
- **`GEMINI_API_KEY` / `OPENAI_API_KEY`** — add to `secrets` only if you stored them in Secrets Manager. Leaving them unset is fine; users can supply their own keys in the UI.
- **`startPeriod: 30`** on the container health check gives Node + Express time to come up before the first probe.

### Frontend task definition

```bash
cat > /tmp/td-frontend.json <<EOF
{
  "family": "mike-prod-frontend",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "256",
  "memory": "512",
  "executionRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/mike-prod-exec",
  "taskRoleArn": "arn:aws:iam::${ACCOUNT_ID}:role/mike-prod-frontend-task",
  "runtimePlatform": { "operatingSystemFamily": "LINUX", "cpuArchitecture": "X86_64" },
  "containerDefinitions": [{
    "name": "frontend",
    "image": "ghcr.io/${GHCR_OWNER}/mike-frontend:${IMAGE_TAG}",
    "essential": true,
    "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
    "healthCheck": {
      "command": ["CMD-SHELL", "wget -qO- http://localhost:3000/ >/dev/null || exit 1"],
      "interval": 30, "timeout": 5, "startPeriod": 20, "retries": 3
    },
    "environment": [
      { "name": "NODE_ENV", "value": "production" },
      { "name": "PORT", "value": "3000" },
      { "name": "NEXT_TELEMETRY_DISABLED", "value": "1" },
      { "name": "NEXT_PUBLIC_API_BASE_URL", "value": "https://${API_FQDN}" },
      { "name": "NEXT_PUBLIC_AWS_REGION", "value": "${AWS_REGION}" },
      { "name": "NEXT_PUBLIC_COGNITO_USER_POOL_ID", "value": "${COGNITO_USER_POOL_ID}" },
      { "name": "NEXT_PUBLIC_COGNITO_CLIENT_ID", "value": "${COGNITO_CLIENT_ID}" }
    ],
    "logConfiguration": {
      "logDriver": "awslogs",
      "options": {
        "awslogs-group": "/ecs/mike-prod/frontend",
        "awslogs-region": "${AWS_REGION}",
        "awslogs-stream-prefix": "ecs"
      }
    }
  }]
}
EOF
aws ecs register-task-definition --cli-input-json file:///tmp/td-frontend.json
```

**Critical Next.js gotcha:** `NEXT_PUBLIC_*` env vars are baked into the JS bundle at **build time**. The image in `ghcr.io/${GHCR_OWNER}/mike-frontend` is built without your prod values. There are two options:

1. **Build your own image** that injects your prod `NEXT_PUBLIC_*` values during `next build`. This is what production-grade deployments do. Either fork the repo and tweak the build workflow, or add an `args:` block to a Buildx invocation that re-builds against the same source.
2. **Accept the defaults baked in by the upstream build** — fine for an internal demo, broken for prod because the bundle will be hardcoded to `http://localhost:3001` for the API.

If you go with (1), publish to your own ECR or a private GHCR namespace and replace the `image:` value in the task definition. See [Appendix A](#appendix-a--optional-improvements) for the GitHub Actions changes.

### Services

```bash
# Backend service
aws ecs create-service \
  --cluster mike-prod \
  --service-name mike-prod-backend \
  --task-definition mike-prod-backend \
  --desired-count 2 \
  --launch-type FARGATE \
  --platform-version LATEST \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_A,$PRIV_B],securityGroups=[$TASKS_SG],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$BACKEND_TG_ARN,containerName=backend,containerPort=3001" \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration "minimumHealthyPercent=100,maximumPercent=200,deploymentCircuitBreaker={enable=true,rollback=true}"

# Frontend service
aws ecs create-service \
  --cluster mike-prod \
  --service-name mike-prod-frontend \
  --task-definition mike-prod-frontend \
  --desired-count 2 \
  --launch-type FARGATE \
  --platform-version LATEST \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_A,$PRIV_B],securityGroups=[$TASKS_SG],assignPublicIp=DISABLED}" \
  --load-balancers "targetGroupArn=$FRONTEND_TG_ARN,containerName=frontend,containerPort=3000" \
  --health-check-grace-period-seconds 60 \
  --deployment-configuration "minimumHealthyPercent=100,maximumPercent=200,deploymentCircuitBreaker={enable=true,rollback=true}"
```

`assignPublicIp=DISABLED` is correct because tasks are in **private** subnets with a NAT route. If you put tasks in public subnets to skip NAT (cost-saving move for non-prod), you must flip this to `ENABLED` so Fargate ENIs can reach the internet.

### Autoscaling (recommended)

Scale backend on CPU; frontend is mostly idle and rarely needs it.

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/mike-prod/mike-prod-backend \
  --min-capacity 2 --max-capacity 10

aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --scalable-dimension ecs:service:DesiredCount \
  --resource-id service/mike-prod/mike-prod-backend \
  --policy-name backend-cpu-target \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 60.0,
    "PredefinedMetricSpecification": {"PredefinedMetricType": "ECSServiceAverageCPUUtilization"},
    "ScaleInCooldown": 300,
    "ScaleOutCooldown": 60
  }'
```

---

## 15. Database migrations

Drizzle migrations live under `backend/drizzle/`. The backend image bundles them and exposes `npm run db:migrate` (which runs `tsx src/db/migrate.ts` against `DATABASE_URL`).

Run as a **one-shot ECS run-task** invocation that overrides the container command:

```bash
aws ecs run-task \
  --cluster mike-prod \
  --task-definition mike-prod-backend \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$PRIV_A,$PRIV_B],securityGroups=[$TASKS_SG],assignPublicIp=DISABLED}" \
  --overrides '{
    "containerOverrides": [{
      "name": "backend",
      "command": ["npm", "run", "db:migrate"]
    }]
  }'
```

Watch it complete:

```bash
aws ecs describe-tasks --cluster mike-prod --tasks $TASK_ARN \
  --query 'tasks[0].{lastStatus:lastStatus,exitCode:containers[0].exitCode}'
```

A successful run returns `lastStatus: STOPPED`, `exitCode: 0`, and logs `Migrations applied`.

**Run this before every deploy that includes a new migration.** The included `ci.yml` already runs `npm run db:migrate` against a fresh Postgres on PR — a broken migration won't merge. For deploys, the simplest reliable pattern is:

1. Deploy a new task definition revision **without** updating the service.
2. Run `run-task` with that revision against prod RDS.
3. If exit 0, update the service to point at the new revision.

A CodePipeline / GitHub Actions deploy job that does (1) → (2) → (3) is straightforward and the right next step.

---

## 16. Smoke test

After services reach `RUNNING` and target groups show `healthy`:

```bash
# Backend health
curl -sf https://${API_FQDN}/health
# {"ok":true}

# Frontend renders
curl -sI https://${APP_FQDN}/ | head -1
# HTTP/2 200
```

Then in a browser:

1. Sign up at `https://${APP_FQDN}` with a real email address.
2. Watch the inbox for the Cognito confirmation code (delivered via SES). Confirm.
3. Upload a small PDF — confirms `multer` accepts the file, the backend uploads to S3, and a presigned download URL works.
4. Upload a `.docx` — confirms the bundled LibreOffice converted it server-side.
5. Start a chat → pick Claude Haiku → send "hi". Confirms Bedrock IAM + model access work and the SSE stream reaches the browser through the ALB (no idle-timeout cut).

If any of these fail, jump to [§21 Troubleshooting](#21-troubleshooting).

---

## 17. Day-2 operations

### Deploying a new image

Don't use `:latest` in production; pin a tag.

```bash
# CI publishes ghcr.io/<owner>/mike-backend:sha-<commit> on every main push.
NEW_TAG=sha-abc1234

# 1. Register a new task def revision with the new image.
aws ecs register-task-definition \
  --cli-input-json "$(aws ecs describe-task-definition --task-definition mike-prod-backend \
    --query 'taskDefinition' --output json \
    | jq --arg img "ghcr.io/${GHCR_OWNER}/mike-backend:${NEW_TAG}" \
        '.containerDefinitions[0].image = $img
         | del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)')"

# 2. If migrations exist, run them now (see §15).

# 3. Roll the service.
aws ecs update-service --cluster mike-prod --service mike-prod-backend \
  --task-definition mike-prod-backend --force-new-deployment
```

The deployment circuit breaker (configured in §14) will roll back automatically if the new task fails to reach `STEADY_STATE`.

### Updating env / secrets

Bumping a value in Secrets Manager **does not** restart tasks. After `put-secret-value`:

```bash
aws ecs update-service --cluster mike-prod --service mike-prod-backend --force-new-deployment
```

For env (not secret) changes, register a new task definition revision with the change baked in, then `update-service`.

### Backups

RDS automated backups are on (`--backup-retention-period 7`). For a manual snapshot before a risky change:

```bash
aws rds create-db-snapshot --db-instance-identifier mike-prod \
  --db-snapshot-identifier mike-prod-pre-$(date +%Y%m%d-%H%M)
```

S3 has versioning on; deleted/overwritten objects are recoverable for the lifecycle window you set (none set here = forever, until you add a lifecycle rule expiring noncurrent versions).

### Scaling

- Tasks: change `desired-count` on the service, or let target-tracking autoscaling do it.
- RDS: `modify-db-instance --db-instance-class db.t4g.medium --apply-immediately` (~30s blip on a single-AZ instance; ~0 downtime on multi-AZ).
- Storage: gp3 grows online with no downtime: `modify-db-instance --allocated-storage 100`.

---

## 18. Observability

### Logs

Both services log JSON-ish text to CloudWatch via the `awslogs` driver. Query with Logs Insights:

```
fields @timestamp, @message
| filter @message like /AccessDenied|error|Error/
| sort @timestamp desc
| limit 100
```

### Container Insights (recommended)

```bash
aws ecs update-cluster-settings --cluster mike-prod \
  --settings name=containerInsights,value=enabled
```

Adds per-task CPU/memory/network metrics under `ECS/ContainerInsights`. ~$0.50/task/month.

### Alarms worth setting up day one

| Alarm | Threshold |
|---|---|
| `ALB 5XX rate (backend)` | `HTTPCode_Target_5XX_Count` > 10 / 5 min |
| `Backend task health` | `HealthyHostCount` on backend TG < 1 for 2 datapoints |
| `RDS CPU` | > 80% for 10 min |
| `RDS free storage` | < 10 GB |
| `RDS connections` | > 80% of `max_connections` (the pool defaults to 10/task, so 20 tasks × 10 = 200 conns; check `max_connections` in the param group is at least 2× headroom) |
| `Bedrock throttle` | CloudWatch metric `bedrock:InvokeModel` `ClientError` > 5 / 5 min |

### Cost + token tracking

Bedrock charges per token. The app already streams tokens through the backend; capture per-request token counts in your application logs and use a Logs Insights query (or push them to CloudWatch metrics) if you want to track spend per user / per chat. The app does not currently emit these metrics — adding it is a small backend change, not a deploy concern.

---

## 19. Cost estimate

Order-of-magnitude monthly cost (`us-east-1`, light prod load):

| Item | Spec | Cost |
|---|---|---|
| Fargate frontend | 2 × (0.25 vCPU, 0.5 GB) 24×7 | ~$15 |
| Fargate backend | 2 × (0.5 vCPU, 2 GB) 24×7 | ~$50 |
| RDS Postgres | db.t4g.small, 50 GB gp3, single-AZ | ~$30 |
| ALB ×2 | 2× $16.20 + LCU | ~$40 |
| NAT Gateway | 1× $32.40 + data | ~$35 |
| S3 | 100 GB stored + requests | ~$3 |
| CloudWatch Logs | ~5 GB/month ingest, 30d retain | ~$3 |
| Cognito | <50k MAU | $0 (free tier) |
| Route 53 hosted zone | 1 | $0.50 |
| Secrets Manager | 5 secrets | ~$2 |
| **Subtotal infrastructure** | | **~$180** |
| Bedrock | Highly variable — usage-based | $$$ |
| SES | 62k emails/month free from EC2; pennies thereafter | ~$0 |

Bedrock dominates total cost as soon as you have real users. Track tokens per chat and set [Bedrock model-level cost guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/cost-management.html) once you've baselined.

Easy savings if you're cost-pressed:

- Drop one ALB and use path-based routing on a shared ALB (-$16/month, complicates CORS).
- Run backend on Fargate Spot for non-prod environments (-70% on compute).
- Shrink RDS to `db.t4g.micro` for non-prod.

---

## 20. Security checklist

Pre-launch:

- [ ] All ECS tasks are in **private** subnets with `assignPublicIp=DISABLED`.
- [ ] RDS is `--no-publicly-accessible` and `--deletion-protection`, with `rds.force_ssl=1`.
- [ ] S3 bucket has Public Access Block on all four toggles and default SSE enabled.
- [ ] S3 CORS allows only `https://${APP_FQDN}` for `GET`.
- [ ] Task role grants `bedrock:InvokeModel*` only on the model ARNs in use, not `*`.
- [ ] Task role grants `cognito-idp:AdminDeleteUser` only on the prod user pool, not all pools.
- [ ] Execution role's Secrets Manager grant is scoped to `mike/prod/*`, not `*`.
- [ ] `USER_API_KEYS_ENCRYPTION_SECRET` is at least 32 bytes of entropy and not committed anywhere.
- [ ] `DOWNLOAD_SIGNING_SECRET` is at least 32 bytes of entropy.
- [ ] Bedrock model access is opted-in only for the families you actually expose.
- [ ] SES is out of sandbox before going live.
- [ ] Cognito password policy is at least 10 chars with mixed case + digits (set in §5b).
- [ ] Cognito `prevent-user-existence-errors` is `ENABLED` (set in §5b — defends against user enumeration).
- [ ] ALB listeners use `ELBSecurityPolicy-TLS13-1-2-2021-06` or stricter.
- [ ] HSTS is on (the backend sets it via `helmet` when `NODE_ENV=production`).
- [ ] CloudTrail is enabled in the account (not covered here — assume baseline org-level config).

After launch:

- [ ] Real backups have been restored once (you've actually tried `restore-db-instance-from-db-snapshot` to a scratch instance).
- [ ] At least one alarm has fired and routed to a human / PagerDuty / Slack.
- [ ] An IAM access review has been done on the task roles after 30 days of real traffic.

---

## 21. Troubleshooting

**Tasks repeatedly stop with `ResourceInitializationError: unable to pull secrets or registry auth`.**

- The **execution role** can't read a referenced Secrets Manager ARN. Re-check the `secrets` block in the task def — typo in the ARN, or the resource doesn't match the role's allow list (`mike/prod/*`).

**Backend tasks come up, fail health checks, and get killed in a loop.**

- Open the log group: usually a missing env var. The most common offenders are `DATABASE_URL` (wrong host or unreachable RDS) and `USER_API_KEYS_ENCRYPTION_SECRET` (referenced but not in Secrets Manager).
- Confirm the security group chain: `tasks-sg` allows 3001 from `alb-backend-sg`, **and** the ALB listener actually points at `backend-tg`.

**Backend logs `Pool.connect: timeout` or `ECONNREFUSED` to RDS.**

- `rds-sg` is missing the inbound 5432 from `tasks-sg`. Confirm with `aws ec2 describe-security-groups --group-ids $RDS_SG`.
- The task is in a subnet whose route table doesn't reach the RDS subnet. They must share the VPC; private route table is fine since RDS uses an ENI in the same VPC.

**`AccessDeniedException` from Bedrock.**

- Bedrock model access not opted in (§8). The error message will name the model ARN you tried.
- Task role missing `bedrock:InvokeModel*` on that specific model ARN. The policy in §11 must include each model id you call.

**`AccessDenied` from S3 with the right bucket name.**

- The task role's S3 statement uses `arn:aws:s3:::${BUCKET}/*` (object-level). If you only granted bucket-level (`arn:aws:s3:::${BUCKET}`), `GetObject`/`PutObject` will fail.

**SSE chat stream gets cut at ~60 seconds.**

- Backend ALB `idle_timeout.timeout_seconds` is still at the default 60. Bump to 180 (§13).

**The frontend hits `http://localhost:3001` in production.**

- The image was built without overriding `NEXT_PUBLIC_API_BASE_URL`. Rebuild with the correct value baked in (see the Critical Next.js gotcha in §14).

**Cognito signup confirmation email never arrives.**

- SES is in sandbox, or the destination address isn't verified. Confirm both with `aws sesv2 get-account` and `aws ses list-verified-email-addresses`.
- The user pool's email configuration is `COGNITO_DEFAULT`, not `DEVELOPER`. Re-run §5b's `--email-configuration` block via `aws cognito-idp update-user-pool`.

**DOC/DOCX upload returns 500 server error.**

- LibreOffice missing in the runtime image. This shouldn't happen with the published `mike-backend` image (the Dockerfile installs `libreoffice`), but a stripped-down rebuild can lose it. Confirm `which soffice` runs successfully in the container via `aws ecs execute-command` (requires ECS Exec opt-in on the service).

**Rate limiter blocks every request from one IP.**

- `TRUST_PROXY_HOPS` is wrong. Behind ALB → ECS task it should be `2`. If it's `0`, every request appears to come from the ALB's internal IP, exhausting the limiter for that IP for the whole window.

---

## Appendix A — Optional improvements

These aren't required to ship, but most prod deployments end up here within a few months:

**Re-build frontend image with prod `NEXT_PUBLIC_*` values.** Fork the build workflow, add `build-args:` for each `NEXT_PUBLIC_*`, and publish to your own namespace (or ECR). Without this, the frontend bundle is hardcoded to the upstream default values.

**Mirror images to ECR.** Better pull latency, IAM-native auth (no Secrets Manager indirection), and lifecycle policies for tag cleanup. Add a job to `build-and-publish.yml` that re-tags the ghcr.io image into `${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/mike-{frontend,backend}` after the existing push.

**WAFv2 in front of both ALBs.** Start with the AWS-managed Common rule set + a per-IP rate-based rule (the in-app limiter only kicks in after the request reaches a task — WAF cuts it earlier and cheaper). ~$5/month base + per-request.

**CodeDeploy blue/green for ECS.** Promotes traffic gradually with auto-rollback on alarm. More moving parts than `force-new-deployment`, but worth it for production releases.

**RDS Multi-AZ + read replica.** Multi-AZ for HA, a read replica if you ever start running expensive reporting queries (currently you don't).

**Move secrets into Parameter Store (SecureString)** if you'd prefer; the only behavioral difference for this app is cost ($0 vs ~$0.40 per secret per month) and the lack of automatic rotation. Either works.

**KMS CMK for SSE-S3 and secrets** instead of AWS-managed keys, if you have a compliance reason. Mind the per-call KMS cost on hot read paths.

**ECS Exec** for `kubectl exec`-style task shell access. Off by default; enable per service with `--enable-execute-command` and add `ssmmessages:CreateControlChannel`, `ssmmessages:CreateDataChannel`, `ssmmessages:OpenControlChannel`, `ssmmessages:OpenDataChannel` to the task role.

---

## Appendix B — Private GHCR images

If you publish images to a private GHCR repo (e.g., a private fork), Fargate needs registry credentials.

1. Create a GitHub PAT with `read:packages` scope.
2. Store it:

```bash
aws secretsmanager create-secret --name mike/prod/ghcr-pull \
  --secret-string '{"username":"YOUR_GH_USERNAME","password":"ghp_xxx"}'
```

3. Grant the **execution role** read:

```json
{
  "Effect": "Allow",
  "Action": ["secretsmanager:GetSecretValue"],
  "Resource": "arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:mike/prod/ghcr-pull-*"
}
```

4. Reference it in each container definition:

```json
"repositoryCredentials": {
  "credentialsParameter": "arn:aws:secretsmanager:us-east-1:<ACCOUNT_ID>:secret:mike/prod/ghcr-pull"
}
```

Rotate the PAT annually. The secret rotation has to be paired with a `force-new-deployment` to pick up the new value (ECS caches the credential at pull time, not per-task).
