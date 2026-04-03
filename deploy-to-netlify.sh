#!/bin/bash
# ─────────────────────────────────────────────────────────
#  Deploy Alpaca Trading Dashboard to Netlify
#  Run this ONCE from the project folder on your machine.
#
#  Requirements: Node.js (already installed if you run server.js)
#  Usage:  bash deploy-to-netlify.sh
# ─────────────────────────────────────────────────────────

SITE_ID="1061a0cc-305e-4500-b5f8-192e30e12aae"

echo ""
echo "  🚀  Deploying Alpaca Trading Dashboard to Netlify"
echo "  Site: https://alpaca-trading-dashboard.netlify.app"
echo ""

# Install the Netlify CLI locally (no global install needed)
echo "  📦  Installing Netlify CLI…"
npx -y netlify-cli@latest deploy \
  --prod \
  --site "$SITE_ID" \
  --dir "." \
  --message "Dashboard deployment"

echo ""
echo "  ✅  Done! Your dashboard is live at:"
echo "  🌐  https://alpaca-trading-dashboard.netlify.app"
echo ""
