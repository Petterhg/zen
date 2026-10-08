import tseslint from "typescript-eslint";
export default tseslint.config(
  {
    ignores: [
      ".upstream/**",
      ".runtime/**",
      "node_modules/**",
      "extension/dist/**",
      "artifacts/**",
      "extension/media/live-protocol.js",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs", "extension/media/*.js", "prototypes/**/*.js"],
    languageOptions: {
      globals: {
        localStorage: "readonly",
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        acquireVsCodeApi: "readonly",
        RTCPeerConnection: "readonly",
        MediaStream: "readonly",
        crypto: "readonly",
        performance: "readonly",
      },
    },
  },
);
