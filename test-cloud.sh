#!/bin/bash

# Restate Cloud 測試腳本
# 用途：驗證 Restate Cloud 部署是否正常運作
#
# 結束碼（Issue #23）：
# - 0 = 所有計數測試通過
# - 1 = 任一測試失敗，或 RESTATE_AUTH_TOKEN 缺失（提前結束，避免自動化「假綠」）

set -e

# Load .env file if it exists
if [ -f .env ]; then
    echo "Loading environment variables from .env file..."
    set -a
    source .env
    set +a
fi

# token 缺失提前非 0 結束：沒有憑證就不可能驗證雲端部署
if [ -z "${RESTATE_AUTH_TOKEN:-}" ]; then
    echo "❌ 未設定 RESTATE_AUTH_TOKEN（請於 .env 或環境變數提供），提前結束。" >&2
    exit 1
fi

# Restate Cloud Ingress URL
RESTATE_CLOUD_URL="https://201kb7y8wxs1nk6t81wyx88dn2q.env.us.restate.cloud:8080"

COLOR_GREEN='\033[0;32m'
COLOR_RED='\033[0;31m'
COLOR_BLUE='\033[0;34m'
COLOR_YELLOW='\033[1;33m'
COLOR_NC='\033[0m' # No Color

# 測試計數器
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
WARNED_TESTS=0

pass_test() {
    echo -e "${COLOR_GREEN}✓ PASS${COLOR_NC}: $1"
    PASSED_TESTS=$((PASSED_TESTS + 1))
}

fail_test() {
    echo -e "${COLOR_RED}✗ FAIL${COLOR_NC}: $1"
    FAILED_TESTS=$((FAILED_TESTS + 1))
}

echo -e "${COLOR_BLUE}========================================${COLOR_NC}"
echo -e "${COLOR_BLUE}Restate Cloud 部署驗證${COLOR_NC}"
echo -e "${COLOR_BLUE}========================================${COLOR_NC}"
echo -e "Cloud URL: $RESTATE_CLOUD_URL\n"

# 測試 1: 成功訂票
echo -e "${COLOR_BLUE}測試 1: 成功訂票 (card_success)${COLOR_NC}"
TOTAL_TESTS=$((TOTAL_TESTS + 1))
RESPONSE=$(curl -s -X POST "$RESTATE_CLOUD_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $RESTATE_AUTH_TOKEN" \
    -d '{"ticketId": "cloud-seat-100", "userId": "cloud-user-100", "paymentMethodId": "card_success"}')

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "Booking Confirmed"; then
    pass_test "雲端訂票成功"
else
    fail_test "雲端訂票失敗"
fi
echo ""

# 測試 2: 支付失敗
echo -e "${COLOR_BLUE}測試 2: 支付失敗 (card_decline)${COLOR_NC}"
TOTAL_TESTS=$((TOTAL_TESTS + 1))
RESPONSE=$(curl -s -X POST "$RESTATE_CLOUD_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $RESTATE_AUTH_TOKEN" \
    -d '{"ticketId": "cloud-seat-101", "userId": "cloud-user-101", "paymentMethodId": "card_decline"}')

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "Payment failed"; then
    pass_test "支付失敗正確回應"
else
    fail_test "支付失敗測試異常"
fi
echo ""

# 測試 3: 查詢票券狀態（SOLD 計入通過；非 SOLD 維持原 INFO 語意、不計失敗）
echo -e "${COLOR_BLUE}測試 3: 查詢票券狀態${COLOR_NC}"
TOTAL_TESTS=$((TOTAL_TESTS + 1))
RESPONSE=$(curl -s -X POST "$RESTATE_CLOUD_URL/Ticket/cloud-seat-100/get" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $RESTATE_AUTH_TOKEN" \
    -d '{}')

echo "Response: $RESPONSE"

if echo "$RESPONSE" | grep -q "SOLD"; then
    pass_test "票券狀態正確"
else
    echo -e "${COLOR_YELLOW}⚠ INFO${COLOR_NC}: 票券狀態: $RESPONSE"
    WARNED_TESTS=$((WARNED_TESTS + 1))
fi
echo ""

# ============================================
# 測試摘要（任一失敗 exit 1，供自動化偵測）
# ============================================
echo -e "${COLOR_BLUE}========================================${COLOR_NC}"
echo -e "${COLOR_BLUE}測試摘要${COLOR_NC}"
echo -e "${COLOR_BLUE}========================================${COLOR_NC}"
echo -e "總測試數: $TOTAL_TESTS"
echo -e "${COLOR_GREEN}PASSED: $PASSED_TESTS${COLOR_NC}"
echo -e "${COLOR_RED}FAILED: $FAILED_TESTS${COLOR_NC}"
echo -e "${COLOR_YELLOW}WARNED: $WARNED_TESTS${COLOR_NC}"

if [ "$FAILED_TESTS" -eq 0 ]; then
    echo -e "\n${COLOR_GREEN}🎉 所有計數測試通過！${COLOR_NC}\n"
    exit 0
else
    echo -e "\n${COLOR_RED}❌ 有測試失敗，請檢查上方詳細訊息${COLOR_NC}\n"
    exit 1
fi
