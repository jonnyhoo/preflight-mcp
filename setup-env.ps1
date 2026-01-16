# Preflight-MCP 环境变量设置脚本
# 换机器时运行一次即可：.\setup-env.ps1
# 运行后需要重启终端/IDE

# OpenRouter Embedding 配置
[Environment]::SetEnvironmentVariable("PREFLIGHT_SEMANTIC_SEARCH", "true", "User")
[Environment]::SetEnvironmentVariable("PREFLIGHT_EMBEDDING_PROVIDER", "openai", "User")
[Environment]::SetEnvironmentVariable("PREFLIGHT_OPENAI_API_KEY", "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", "User")
[Environment]::SetEnvironmentVariable("PREFLIGHT_OPENAI_BASE_URL", "https://openrouter.ai/api/v1", "User")
[Environment]::SetEnvironmentVariable("PREFLIGHT_OPENAI_MODEL", "qwen/qwen3-embedding-8b", "User")

Write-Host "Done! Please restart terminal or IDE." -ForegroundColor Green
