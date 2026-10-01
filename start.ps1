param(
  [int]$Port = 8766,
  [string]$Origins = 'http://localhost:8000,http://127.0.0.1:8000,http://tauri.localhost,tauri://localhost'
)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/@modelcontextprotocol/sdk/package.json'))) {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'MCP dependency installation failed.' }
  }
  $env:TB_MCP_PORT = [string]$Port
  $env:TB_MCP_ORIGINS = $Origins
  & node server.mjs
  if ($LASTEXITCODE -ne 0) { throw 'MCP server stopped with an error.' }
} finally {
  Pop-Location
}
