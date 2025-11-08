#!/bin/bash

# Diagnostic script to check Docker setup for Claude Code

echo "Checking Claude Code Docker Setup..."
echo "====================================="
echo ""

# Check claude-data directory
echo "1. Checking claude-data directory..."
if [ -d "./claude-data" ]; then
    echo "   ✓ claude-data directory exists"

    if [ -f "./claude-data/.credentials.json" ]; then
        echo "   ✓ .credentials.json exists"

        # Check permissions
        PERMS=$(stat -f "%Lp" "./claude-data/.credentials.json" 2>/dev/null || stat -c "%a" "./claude-data/.credentials.json" 2>/dev/null)
        echo "   ℹ Permissions: $PERMS"

        # Check if readable
        if [ -r "./claude-data/.credentials.json" ]; then
            echo "   ✓ .credentials.json is readable"

            # Check if it has OAuth tokens
            if grep -q "claudeAiOauth" "./claude-data/.credentials.json" 2>/dev/null; then
                echo "   ✓ OAuth tokens found in credentials"

                # Check expiration
                if command -v jq &> /dev/null; then
                    EXPIRES=$(jq -r '.claudeAiOauth.expiresAt' "./claude-data/.credentials.json" 2>/dev/null)
                    if [ -n "$EXPIRES" ] && [ "$EXPIRES" != "null" ]; then
                        EXPIRES_SEC=$((EXPIRES / 1000))
                        NOW=$(date +%s)
                        if [ $EXPIRES_SEC -gt $NOW ]; then
                            echo "   ✓ Token is valid (not expired)"
                        else
                            echo "   ✗ Token is EXPIRED - re-authenticate in container"
                        fi
                    fi
                fi
            else
                echo "   ⚠ Credentials file exists but may be empty"
            fi
        else
            echo "   ✗ .credentials.json is NOT readable"
        fi
    else
        echo "   ✗ .credentials.json NOT found"
        echo "   → Authenticate inside container: docker exec -it claude-code-env claude"
    fi
else
    echo "   ✗ claude-data directory NOT found"
    echo "   → Run ./setup.sh to set up the environment"
fi

echo ""

# Check git-data directory
echo "2. Checking git-data directory..."
if [ -d "./git-data" ]; then
    echo "   ✓ git-data directory exists"

    if [ -f "./git-data/.gitconfig" ]; then
        echo "   ✓ .gitconfig exists"
    else
        echo "   ⚠ .gitconfig NOT found"
    fi

    if [ -d "./git-data/.ssh" ]; then
        echo "   ✓ .ssh directory exists"
    else
        echo "   ⚠ .ssh directory NOT found"
    fi
else
    echo "   ✗ git-data directory NOT found"
    echo "   → Run ./setup.sh to set up the environment"
fi

echo ""

# Check workspace directory
echo "3. Checking workspace directory..."
if [ -d "./workspace" ]; then
    echo "   ✓ workspace directory exists"
else
    echo "   ✗ workspace directory NOT found"
    echo "   → Run ./setup.sh to create it"
fi

echo ""

# Check .env file
echo "4. Checking .env file..."
if [ -f ".env" ]; then
    echo "   ✓ .env file exists"

    if grep -q "GIT_REPO_URL=" .env; then
        GIT_URL=$(grep "GIT_REPO_URL=" .env | cut -d'=' -f2)
        if [ -n "$GIT_URL" ]; then
            echo "   ✓ GIT_REPO_URL configured: $GIT_URL"
        else
            echo "   ℹ GIT_REPO_URL not set (auto-clone disabled)"
        fi
    fi
else
    echo "   ⚠ .env file NOT found"
    echo "   → Run ./setup.sh to create it"
fi

echo ""

# Check Docker
echo "5. Checking Docker..."
if command -v docker &> /dev/null; then
    echo "   ✓ Docker installed"

    if docker ps &> /dev/null; then
        echo "   ✓ Docker daemon running"
    else
        echo "   ✗ Docker daemon NOT running"
        echo "   → Start Docker Desktop or Docker daemon"
    fi
else
    echo "   ✗ Docker NOT installed"
fi

echo ""

# Check Docker Compose
echo "6. Checking Docker Compose..."
if command -v docker-compose &> /dev/null || docker compose version &> /dev/null; then
    echo "   ✓ Docker Compose available"
else
    echo "   ✗ Docker Compose NOT available"
fi

echo ""
echo "====================================="
echo "Setup check complete!"
echo ""

# Final recommendation
if [ ! -d "./claude-data" ] || [ ! -f "./claude-data/.credentials.json" ]; then
    echo "⚠ NEXT STEP: Run ./setup.sh to complete setup"
else
    echo "✓ Setup looks good! Run: docker-compose run --rm claude-code"
fi
