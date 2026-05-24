module.exports = {
  apps: [
    {
      name: 'local-ai-gateway',
      script: 'dist/server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production'
      },
      max_memory_restart: '512M',
      time: true
    }
  ]
};
