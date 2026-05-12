import { SSTConfig } from "sst";
import * as sst from "sst/constructs";

export default {
  config(_input) {
    return {
      name: "mike",
      region: "us-east-1",
    };
  },
  stacks(app) {
    app.stack(function Site({ stack }) {
      // VPC with NAT gateway for private subnet internet access
      const vpc = new sst.aws.Vpc("Vpc", {
        nat: "managed",
      });

      // RDS Postgres database with RDS Proxy enabled
      const db = new sst.aws.Postgres("Database", {
        vpc,
        proxy: true,
      });

      // S3 bucket for document storage
      const storage = new sst.aws.Bucket("Storage");

      // Secrets for the application
      const clerkSecretKey = new sst.Secret("ClerkSecretKey");
      const clerkPublishableKey = new sst.Secret("ClerkPublishableKey");
      const clerkJwtKey = new sst.Secret("ClerkJwtKey");
      const anthropicApiKey = new sst.Secret("AnthropicApiKey");
      const geminiApiKey = new sst.Secret("GeminiApiKey");
      const openAIApiKey = new sst.Secret("OpenAIApiKey");
      const userApiKeysEncryptionSecret = new sst.Secret("UserApiKeysEncryptionSecret");
      const downloadSigningSecret = new sst.Secret("DownloadSigningSecret");
      const sesFromAddress = new sst.Secret("SesFromAddress");

      // Backend Express API service on Fargate
      const api = new sst.aws.Service("Api", {
        vpc,
        containers: {
          app: {
            image: {
              context: "./backend",
              dockerfile: "Dockerfile",
            },
            port: 3001,
            cpu: "0.5 vCPU",
            memory: "1 GB",
          },
        },
        loadBalancer: {
          public: true,
        },
        link: [
          db,
          storage,
          clerkSecretKey,
          clerkPublishableKey,
          clerkJwtKey,
          anthropicApiKey,
          geminiApiKey,
          openAIApiKey,
          userApiKeysEncryptionSecret,
          downloadSigningSecret,
          sesFromAddress,
        ],
      });

      // Frontend Next.js application
      const web = new sst.aws.Nextjs("Web", {
        path: "./frontend",
        link: [api],
      });

      // Export URLs for reference
      stack.addOutputs({
        ApiUrl: api.url,
        WebUrl: web.url,
      });
    });
  },
} satisfies SSTConfig;
