// PM2 runs the app launcher as one process. The launcher starts Next.js and the
// research worker together and applies in-app updates (git pull + restart), so
// Next and the worker must not be registered as separate PM2 apps.
module.exports = {
  apps: [
    {
      name: "our-toy-3000",
      cwd: __dirname,
      script: "scripts/launch.mjs",
      // Production server: no dev compiler or file-watch polling. The launcher
      // rebuilds automatically when sources are newer than the build.
      args: "start",
      interpreter: process.execPath,
      env: { NODE_ENV: "production" },
      autorestart: true,
      max_restarts: 5,
      restart_delay: 3000,
      kill_timeout: 15000,
      time: true,
    },
  ],
};
