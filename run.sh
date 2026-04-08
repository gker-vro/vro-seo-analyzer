#!/bin/bash
# VRO SEO Analyzer — Quick Start
# Run this script from the vro-seo-analyzer folder

echo ""
echo "  🔍 VRO SEO Analyzer — Setup & Launch"
echo "  ────────────────────────────────────────"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "  ❌ Node.js not found. Install it from https://nodejs.org"
    exit 1
fi

echo "  ✓ Node.js $(node -v)"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "  📦 Installing dependencies..."
    npm install
    echo ""
fi

# Check .env
if [ ! -f ".env" ]; then
    echo "  ⚠️  No .env file found. Copying from .env.example..."
    cp .env.example .env
    echo "  📝 Edit .env to add your Ahrefs/SEMrush API keys (optional)"
    echo ""
fi

# Launch
echo "  🚀 Starting server..."
echo ""
node server.js
