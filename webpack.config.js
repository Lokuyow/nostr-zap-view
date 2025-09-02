const path = require("path");
const TerserPlugin = require("terser-webpack-plugin");
const fs = require("fs");
const CopyPlugin = require('copy-webpack-plugin');

module.exports = [
  {
    entry: "./src/index.js",
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "nostr-zap-view.js",
      library: "nostrZapView",
      libraryTarget: "umd",
    },
    mode: "production",
    module: {
      rules: [
        {
          test: /\.css$/,
          use: ["to-string-loader", "css-loader"],
        },
        {
          test: /\.svg$/,
          type: "asset/inline",
        },
      ],
    },
    resolve: {
      modules: [path.resolve(__dirname, "src"), "node_modules"],
    },
    optimization: {
      minimize: true,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            format: {
              comments: /@license/i,
            },
            compress: {
              drop_console: true,
            },
          },
          extractComments: {
            condition: "some",
            banner: () => {
              return fs.readFileSync(path.resolve(__dirname, "LICENSE"), "utf8");
            },
          },
        }),
      ],
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: "src/types/index.d.ts", to: "index.d.ts" }
        ],
      }),
    ],
  },
  {
    // ESModule用の設定を追加
    entry: "./src/index.js",
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "nostr-zap-view.esm.js",
      library: { type: "module" },
      chunkFormat: "module",
    },
    experiments: {
      outputModule: true,
    },
    mode: "production",
    module: {
      rules: [
        {
          test: /\.css$/,
          use: ["to-string-loader", "css-loader"],
        },
        {
          test: /\.svg$/,
          type: "asset/inline",
        },
      ],
    },
    resolve: {
      modules: [path.resolve(__dirname, "src"), "node_modules"],
    },
    optimization: {
      minimize: true,
      minimizer: [
        new TerserPlugin({
          terserOptions: {
            format: {
              comments: /@license/i,
            },
            compress: {
              drop_console: true,
            },
          },
          extractComments: {
            condition: "some",
            banner: () => {
              return fs.readFileSync(path.resolve(__dirname, "LICENSE"), "utf8");
            },
          },
        }),
      ],
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          { from: "src/types/index.d.ts", to: "index.d.ts" }
        ],
      }),
    ],
  },
];
