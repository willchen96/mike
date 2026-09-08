/* eslint-disable @typescript-eslint/no-var-requires */
const path = require("path");
const fs = require("fs");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const webpack = require("webpack");

const frontendShared = (...segments) =>
  path.resolve(__dirname, "..", "frontend", "src", "shared", ...segments);
const frontendSharedUi = (filename) => frontendShared("ui", filename);

module.exports = async (_env, options) => {
  const isDev = options.mode !== "production";

  // npm and webpack do not read .env files themselves. Load the add-in's
  // local development configuration here so `npm run dev`, `bun dev`, and
  // `npm start` all receive the same values without a shell-specific `source`
  // step. Node's loader preserves variables already supplied by the shell, so
  // explicit CI/deployment overrides continue to win.
  const localEnvPath = path.join(__dirname, ".env");
  if (isDev && fs.existsSync(localEnvPath)) {
    if (typeof process.loadEnvFile !== "function") {
      throw new Error(
        "The Word add-in requires Node.js 22 or newer to load word-addin/.env.",
      );
    }
    process.loadEnvFile(localEnvPath);
  }

  if (!isDev) {
    const required = [
      "REACT_APP_WEB_APP_URL",
    ];
    const missing = required.filter((name) => !process.env[name]?.trim());
    if (missing.length > 0) {
      throw new Error(
        `Production Word build is missing: ${missing.join(", ")}`,
      );
    }
    const apiBase = process.env.REACT_APP_API_BASE_URL || "/api";
    if (!apiBase.startsWith("/")) {
      throw new Error(
        "Production REACT_APP_API_BASE_URL must be same-origin (for example /api) so HttpOnly auth cookies work in every Word host.",
      );
    }
  }

  /** @type {import('webpack-dev-server').Configuration} */
  const devServerConfig = {
    port: 3200,
    hot: true,
    // compress defaults to true, and the gzip middleware buffers
    // text/event-stream bodies until the response ends — which turns the /chat
    // SSE proxy into one giant blob delivered only when generation finishes.
    // Disable it so streamed tokens reach the task pane as they arrive.
    compress: false,
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
    static: [
      {
        directory: path.join(__dirname, "assets"),
        publicPath: "/assets",
      },
    ],
  };

  if (isDev) {
    // Dev-only: self-signed HTTPS cert for the webpack-dev-server on
    // localhost:3200. office-addin-dev-certs installs its CA into the OS
    // keychain, which pops an admin prompt — impossible to approve in
    // automated/headless environments. DEV_HTTPS_CERT/DEV_HTTPS_KEY serve
    // existing cert files directly instead (the driving browser must then
    // tolerate the untrusted cert, e.g. --ignore-certificate-errors).
    if (process.env.DEV_HTTPS_CERT && process.env.DEV_HTTPS_KEY) {
      const fs = require("fs");
      devServerConfig.server = {
        type: "https",
        options: {
          cert: fs.readFileSync(process.env.DEV_HTTPS_CERT),
          key: fs.readFileSync(process.env.DEV_HTTPS_KEY),
        },
      };
    } else {
      // Required lazily so production builds (`--mode production`) don't
      // depend on this dev-only package at all.
      const { getHttpsServerOptions } = require("office-addin-dev-certs");
      const httpsOptions = await getHttpsServerOptions();
      devServerConfig.server = { type: "https", options: httpsOptions };
    }

    // Word loads the task pane over HTTPS, and its WebView blocks "mixed content"
    // (HTTP requests from an HTTPS page). Proxy the local Mike API through this
    // HTTPS dev server so authentication and API calls stay same-origin and the
    // HttpOnly session cookie works consistently across Word hosts.
    const apiTarget = process.env.API_PROXY_TARGET || "http://localhost:3001";
    const objectStorageTarget =
      process.env.OBJECT_STORAGE_PROXY_TARGET || "http://localhost:9000";
    const objectStorageBucketName =
      process.env.OBJECT_STORAGE_BUCKET_NAME || "mike";
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(objectStorageBucketName)) {
      throw new Error("OBJECT_STORAGE_BUCKET_NAME is not a valid bucket name");
    }
    devServerConfig.proxy = [
      {
        context: ["/api"],
        target: apiTarget,
        changeOrigin: true,
        secure: false,
        pathRewrite: { "^/api": "" },
      },
      {
        // A local signed URL can use https://localhost:3200 as its public
        // endpoint. Keep the original Host header so it still matches the
        // SigV4 signature while webpack forwards the bytes to local storage.
        context: [`/${objectStorageBucketName}`],
        target: objectStorageTarget,
        changeOrigin: false,
        secure: false,
      },
    ];
  }

  /** @type {import('webpack').Configuration} */
  const config = {
    // Keep readable stack traces locally without publishing application source
    // and embedded source content in production artifacts.
    devtool: isDev ? "source-map" : false,
    entry: {
      taskpane: "./src/taskpane/index.tsx",
      commands: "./src/commands/commands.ts",
      oauthDialog: "./src/oauth-dialog/index.ts",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: isDev ? "[name].js" : "[name].[contenthash:8].js",
      chunkFilename: isDev ? "[id].js" : "[id].[contenthash:8].js",
      clean: true,
    },
    resolve: {
      extensions: [".ts", ".tsx", ".js", ".jsx"],
      modules: [path.resolve(__dirname, "node_modules"), "node_modules"],
      alias: {
        // Cross-app source files must use the add-in's React runtime so the
        // bundle never picks up a second copy from frontend/node_modules.
        "react$": require.resolve("react"),
        "react/jsx-runtime$": require.resolve("react/jsx-runtime"),
        "react-dom$": require.resolve("react-dom"),
        "lucide-react$": require.resolve(
          "lucide-react/dist/esm/lucide-react.js",
        ),
        // The frontend's public icon set is canonical. Webpack imports those
        // same SVGs and emits content-hashed copies for the add-in bundle.
        "@icons": path.resolve(__dirname, "..", "frontend", "public", "icons"),
        "@mike/edit-card-ui": frontendSharedUi("EditCardUI.tsx"),
        "@mike/edit-cards-section-ui": frontendSharedUi(
          "EditCardsSectionUI.tsx",
        ),
        "@mike/pre-response-wrapper-ui": frontendSharedUi(
          "PreResponseWrapperUI.tsx",
        ),
        "@mike/document-event-blocks-ui": frontendSharedUi(
          "DocumentEventBlocksUI.tsx",
        ),
        "@mike/glass-card-ui": frontendSharedUi("GlassCardUI.tsx"),
        "@mike/liquid-glass-ui": frontendSharedUi("LiquidGlassUI.ts"),
        "@mike/modal-ui": frontendSharedUi("ModalUI.tsx"),
        "@mike/header-buttons-ui": frontendSharedUi(
          "HeaderButtonsUI.tsx",
        ),
        "@mike/pill-button-ui": frontendSharedUi("PillButtonUI.tsx"),
        "@mike/dropdown-ui": frontendSharedUi("DropdownUI.tsx"),
        "@mike/citation-pill-ui": frontendSharedUi("CitationPillUI.tsx"),
        "@mike/model-toggle-ui": frontendSharedUi("ModelToggleUI.tsx"),
        "@mike/mike-icon-ui": frontendSharedUi("MikeIconUI.tsx"),
        "@mike/google-icon-ui": frontendSharedUi("GoogleIconUI.tsx"),
        "@mike/auth-styles-ui": frontendSharedUi("AuthStylesUI.ts"),
        "@mike/auth-divider-ui": frontendSharedUi("AuthDividerUI.tsx"),
        "@mike/workflow-slash-command-ui": frontendSharedUi(
          "WorkflowSlashCommandUI.tsx",
        ),
        // Non-UI shared modules: the upload-session client and the UUID helper
        // it mints client ids with.
        "@mike/upload-session-client": frontendShared(
          "api",
          "uploadSessionClient.ts",
        ),
        "@mike/secure-uuid": frontendShared("lib", "secureUuid.ts"),
      },
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          // Type-checking is done separately via `tsc --noEmit`.
          use: {
            loader: "ts-loader",
            options: { transpileOnly: true },
          },
          exclude: /node_modules/,
        },
        {
          test: /\.css$/,
          use: ["style-loader", "css-loader", "postcss-loader"],
        },
        {
          test: /\.svg$/i,
          type: "asset/resource",
          generator: {
            filename: "icons/[name].[contenthash][ext]",
          },
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        template: "./src/taskpane/index.html",
        chunks: ["taskpane"],
      }),
      new HtmlWebpackPlugin({
        filename: "commands.html",
        template: "./src/commands/commands.html",
        chunks: ["commands"],
      }),
      new HtmlWebpackPlugin({
        filename: "oauth-dialog.html",
        template: "./src/oauth-dialog/index.html",
        chunks: ["oauthDialog"],
      }),
      // Expose env vars to the bundle so TypeScript process.env calls compile
      new webpack.EnvironmentPlugin({
        // Development defaults stay on the HTTPS dev-server origin, whose
        // proxies reach the HTTP backends without mixed-content failures.
        // Production hosting must reverse-proxy this same-origin path to the
        // Mike backend so HttpOnly auth cookies are never third-party cookies.
        REACT_APP_API_BASE_URL:
          process.env.REACT_APP_API_BASE_URL || "/api",
        REACT_APP_DEFAULT_MODEL: "gemini-3-flash-preview",
        // The Mike web app origin — the task pane links here (e.g. the
        // account/api-keys page); it never fetches from it.
        REACT_APP_WEB_APP_URL: isDev
          ? process.env.REACT_APP_WEB_APP_URL || "https://app.mikeoss.com"
          : undefined,
      }),
    ],
    devServer: devServerConfig,
  };

  return config;
};
