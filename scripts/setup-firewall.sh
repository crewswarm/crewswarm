#!/usr/bin/env bash
# crewswarm Network Firewall Rules (iptables)
# Blocks cloud metadata endpoints and restricts outbound traffic to LLM APIs only
#
# Based on: AI agent exfiltration research, Docker network security best practices
#
# Usage: sudo bash scripts/setup-firewall.sh

set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  crewswarm Network Firewall Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "❌ This script must be run as root (use sudo)"
   exit 1
fi

# Detect Docker network subnet
DOCKER_SUBNET=$(docker network inspect crewswarm_net -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || echo "172.20.0.0/16")
echo "✓ Docker subnet detected: ${DOCKER_SUBNET}"

# ── Block Cloud Metadata Endpoints ────────────────────────────────────────────
echo ""
echo "Blocking cloud metadata endpoints..."

# AWS metadata
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d 169.254.169.254/32 -j DROP
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d 169.254.169.253/32 -j DROP

# GCP metadata
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d 169.254.169.254/32 -p tcp --dport 80 -j DROP
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d metadata.google.internal -j DROP

# Azure metadata
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d 169.254.169.254/32 -p tcp --dport 80 -j DROP

echo "✓ Cloud metadata endpoints blocked"

# ── Allowlist LLM API Domains ──────────────────────────────────────────────────
echo ""
echo "Configuring LLM API allowlist..."

# Anthropic (Claude)
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d api.anthropic.com -p tcp --dport 443 -j ACCEPT

# OpenAI
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d api.openai.com -p tcp --dport 443 -j ACCEPT

# Groq
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d api.groq.com -p tcp --dport 443 -j ACCEPT

# Mistral
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d api.mistral.ai -p tcp --dport 443 -j ACCEPT

# Cerebras
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d api.cerebras.ai -p tcp --dport 443 -j ACCEPT

# DeepSeek
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d api.deepseek.com -p tcp --dport 443 -j ACCEPT

# Perplexity
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d api.perplexity.ai -p tcp --dport 443 -j ACCEPT

# Google (Gemini)
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d generativelanguage.googleapis.com -p tcp --dport 443 -j ACCEPT

# xAI (Grok)
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d api.x.ai -p tcp --dport 443 -j ACCEPT

# NVIDIA
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -d integrate.api.nvidia.com -p tcp --dport 443 -j ACCEPT

# Allow DNS (required for domain resolution)
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -p udp --dport 53 -j ACCEPT
iptables -I DOCKER-USER -s ${DOCKER_SUBNET} -p tcp --dport 53 -j ACCEPT

echo "✓ LLM API domains allowlisted"

# ── Block All Other Outbound Traffic (Optional - Commented Out) ────────────────
echo ""
echo "⚠️  Strict outbound blocking is DISABLED by default."
echo "    Uncomment the line below to block all non-allowlisted outbound traffic:"
echo ""
echo "    # iptables -A DOCKER-USER -s ${DOCKER_SUBNET} -j DROP"
echo ""
echo "    WARNING: This will break npm installs, git clones, etc."
echo "             Only enable if you want MAXIMUM security and agents don't need"
echo "             to install packages or access external resources."
echo ""

# Uncomment to enable strict blocking (agents can ONLY call LLM APIs)
# iptables -A DOCKER-USER -s ${DOCKER_SUBNET} -j DROP

# ── Save Rules ─────────────────────────────────────────────────────────────────
echo "Saving iptables rules..."

if command -v netfilter-persistent &>/dev/null; then
  netfilter-persistent save
  echo "✓ Rules saved (netfilter-persistent)"
elif command -v iptables-save &>/dev/null; then
  iptables-save > /etc/iptables/rules.v4
  echo "✓ Rules saved (/etc/iptables/rules.v4)"
else
  echo "⚠️  Could not find netfilter-persistent or iptables-save"
  echo "    Rules will NOT persist after reboot"
  echo "    Install: sudo apt install iptables-persistent"
fi

# ── Verify Rules ───────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Firewall Rules Active"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  ✓ Cloud metadata endpoints blocked (AWS, GCP, Azure)"
echo "  ✓ LLM API domains allowlisted"
echo "  ⚠️  Strict outbound blocking: DISABLED (agents can still access internet)"
echo ""
echo "To view rules:"
echo "  sudo iptables -L DOCKER-USER -n -v"
echo ""
echo "To remove all rules:"
echo "  sudo iptables -F DOCKER-USER"
echo ""
