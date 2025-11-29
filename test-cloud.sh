#!/bin/bash

# Restate Cloud 測試腳本
# 用途：驗證 Restate Cloud 部署是否正常運作

set -e

# Load .env file if it exists
if [ -f .env ]; then
    echo "Loading environment variables from .env file..."
    set -a
    source .env
    set +a
fi

# Restate Cloud Ingress URL
RESTATE_CLOUD_URL="https://201kb7y8wxs1nk6t81wyx88dn2q.env.us.restate.cloud:8080"

COLOR_GREEN='\033[0;32m'
COLOR_RED='\033[0;31m'
COLOR_BLUE='\033[0;34m'
COLOR_NC='\033[0m' # No Color

echo -e "${COLOR_BLUE}========================================${COLOR_NC}"
echo -e "${COLOR_BLUE}Restate Cloud 部署驗證${COLOR_NC}"
echo -e "${COLOR_BLUE}========================================${COLOR_NC}"
echo -e "Cloud URL: $RESTATE_CLOUD_URL\n"

# 測試 1: 成功訂票
echo -e "${COLOR_BLUE}測試 1: 成功訂票 (card_success)${COLOR_NC}"
RESPONSE=$(curl -s -X POST "$RESTATE_CLOUD_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $RESTATE_AUTH_TOKEN" \
    -d '{"ticketId": "cloud-seat-100", "userId": "cloud-user-100", "paymentMethodId": "card_success"}')

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "Booking Confirmed"; then
    echo -e "${COLOR_GREEN}✓ PASS${COLOR_NC}: 雲端訂票成功\n"
else
    echo -e "${COLOR_RED}✗ FAIL${COLOR_NC}: 雲端訂票失敗"
    echo "Response: $RESPONSE\n"
fi

# 測試 2: 支付失敗
echo -e "${COLOR_BLUE}測試 2: 支付失敗 (card_decline)${COLOR_NC}"
RESPONSE=$(curl -s -X POST "$RESTATE_CLOUD_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $RESTATE_AUTH_TOKEN" \
    -d '{"ticketId": "cloud-seat-101", "userId": "cloud-user-101", "paymentMethodId": "card_decline"}')

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "Payment failed"; then
    echo -e "${COLOR_GREEN}✓ PASS${COLOR_NC}: 支付失敗正確回應\n"
else
    echo -e "${COLOR_RED}✗ FAIL${COLOR_NC}: 支付失敗測試異常\n"
fi

# 測試 3: 查詢票券狀態
echo -e "${COLOR_BLUE}測試 3: 查詢票券狀態${COLOR_NC}"
RESPONSE=$(curl -s -X POST "$RESTATE_CLOUD_URL/Ticket/cloud-seat-100/get" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $RESTATE_AUTH_TOKEN" \
    -d '{}')

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "SOLD"; then
    echo -e "${COLOR_GREEN}✓ PASS${COLOR_NC}: 票券狀態正確\n"
else
    echo -e "${COLOR_YELLOW}⚠ INFO${COLOR_NC}: 票券狀態: $RESPONSE\n"
fi

echo -e "${COLOR_BLUE}========================================${COLOR_NC}"
echo -e "${COLOR_BLUE}測試完成${COLOR_NC}"
echo -e "${COLOR_BLUE}========================================${COLOR_NC}"
