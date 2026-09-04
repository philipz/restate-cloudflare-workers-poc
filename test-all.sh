#!/bin/bash

# Nexus PoC - 完整測試腳本
# 用途：驗證所有票務系統功能
#
# 可重複執行設計（Issue #23）：
# - 每次執行使用唯一 run 前綴（RUN_ID，可用環境變數覆蓋）作為座位 id，
#   避開持久化 Restate 实例上的上次殘留狀態。
# - 執行前呼叫 SeatMap/global/reset 與 Ticket/{id}/cleanup，
#   確保起始狀態乾淨（同時覆蓋這兩個 handler）。

set -e

RESTATE_URL="http://localhost:8080"
COLOR_GREEN='\033[0;32m'
COLOR_RED='\033[0;31m'
COLOR_BLUE='\033[0;34m'
COLOR_YELLOW='\033[1;33m'
COLOR_NC='\033[0m' # No Color

# 本次執行的唯一 run 前綴：同一本地 Restate 連跑兩次不互相污染
RUN_ID="${RUN_ID:-$(date +%s)-$$}"
SEAT_PREFIX="run-${RUN_ID}"

# 本次執行會用到的所有 ticket/object id
SEAT1="$SEAT_PREFIX-seat-1"
SEAT2="$SEAT_PREFIX-seat-2"
SEAT3="$SEAT_PREFIX-seat-3"
SEAT4="$SEAT_PREFIX-seat-4"
SEAT5="$SEAT_PREFIX-seat-5"
SEAT6="$SEAT_PREFIX-seat-6"
BULK_IDS=()
for i in {1..5}; do
    BULK_IDS+=("$SEAT_PREFIX-bulk-seat-$i")
done
ALL_IDS=("$SEAT1" "$SEAT2" "$SEAT3" "$SEAT4" "$SEAT5" "$SEAT6" "${BULK_IDS[@]}")

# 測試計數器
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# 輔助函數：打印測試標題
print_test() {
    echo -e "\n${COLOR_BLUE}========================================${COLOR_NC}"
    echo -e "${COLOR_BLUE}測試 $1: $2${COLOR_NC}"
    echo -e "${COLOR_BLUE}========================================${COLOR_NC}"
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
}

# 輔助函數：驗證結果
assert_contains() {
    local response="$1"
    local expected="$2"
    local test_name="$3"
    
    if echo "$response" | grep -q "$expected"; then
        echo -e "${COLOR_GREEN}✓ PASS${COLOR_NC}: $test_name"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    else
        echo -e "${COLOR_RED}✗ FAIL${COLOR_NC}: $test_name"
        echo -e "${COLOR_RED}Expected to contain: $expected${COLOR_NC}"
        echo -e "${COLOR_RED}Actual response: $response${COLOR_NC}"
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 1
    fi
}

# 輔助函數：等待一秒
wait_a_bit() {
    sleep 1
}

echo -e "${COLOR_YELLOW}開始執行 Nexus PoC 完整測試套件...${COLOR_NC}"
echo -e "${COLOR_YELLOW}Restate URL: $RESTATE_URL${COLOR_NC}"
echo -e "${COLOR_YELLOW}本次執行 run 前綴: $SEAT_PREFIX${COLOR_NC}\n"

# ============================================
# 測試 0: 執行前清理（SeatMap/global/reset + Ticket/{id}/cleanup）
# ============================================
print_test "0" "執行前清理（SeatMap reset + Ticket cleanup）"

# SeatMap/global/reset：既有但零使用的 handler——重置全域座位視圖
curl -s -X POST "$RESTATE_URL/SeatMap/global/reset" \
    -H "Content-Type: application/json" -d '{}' > /dev/null

# 驗證 reset 生效：重置後應包含 seat-1 條目且狀態為 AVAILABLE
SEATMAP=$(curl -s -X POST "$RESTATE_URL/SeatMap/global/get" \
    -H "Content-Type: application/json" -d '{}')
assert_contains "$SEATMAP" '"id":"seat-1"' "SeatMap reset 後包含 seat-1 條目"
assert_contains "$SEATMAP" "AVAILABLE" "SeatMap reset 後座位為 AVAILABLE"

# Ticket/{id}/cleanup：既有但零使用的 handler——逐一清理本次將使用的票券
for ID in "${ALL_IDS[@]}"; do
    CLEANUP_RESP=$(curl -s -X POST "$RESTATE_URL/Ticket/$ID/cleanup" \
        -H "Content-Type: application/json" -d '{}')
    assert_contains "$CLEANUP_RESP" "true" "Ticket $ID cleanup 回傳 true"
done

# 驗證清理生效：cleanup 後 get 應回到 AVAILABLE
STATE=$(curl -s -X POST "$RESTATE_URL/Ticket/$SEAT1/get" \
    -H "Content-Type: application/json" -d '{}')
assert_contains "$STATE" "AVAILABLE" "Ticket cleanup 後狀態為 AVAILABLE"

# ============================================
# 測試 1: 成功訂票流程 (Happy Path)
# ============================================
print_test "1" "成功訂票流程 (card_success)"

RESPONSE=$(curl -s -X POST "$RESTATE_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -d "{\"ticketId\": \"$SEAT1\", \"userId\": \"test-user-1\", \"paymentMethodId\": \"card_success\"}")

assert_contains "$RESPONSE" "Booking Confirmed" "訂票成功返回確認訊息"

wait_a_bit

# 驗證票券狀態為 SOLD
STATE=$(curl -s -X POST "$RESTATE_URL/Ticket/$SEAT1/get" \
    -H "Content-Type: application/json" -d '{}')

assert_contains "$STATE" "SOLD" "票券狀態為 SOLD"
assert_contains "$STATE" "test-user-1" "票券保留給正確的用戶"

# ============================================
# 測試 2: 支付失敗與補償 (Saga Pattern)
# ============================================
print_test "2" "支付失敗與補償流程 (card_decline)"

RESPONSE=$(curl -s -X POST "$RESTATE_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -d "{\"ticketId\": \"$SEAT2\", \"userId\": \"test-user-2\", \"paymentMethodId\": \"card_decline\"}")

assert_contains "$RESPONSE" "Payment failed" "支付失敗返回錯誤訊息"
assert_contains "$RESPONSE" "Payment declined" "錯誤訊息包含 'Payment declined'"

wait_a_bit

# 驗證補償邏輯：票券應該被釋放回 AVAILABLE
STATE=$(curl -s -X POST "$RESTATE_URL/Ticket/$SEAT2/get" \
    -H "Content-Type: application/json" -d '{}')

assert_contains "$STATE" "AVAILABLE" "補償後票券狀態為 AVAILABLE"

# ============================================
# 測試 3: 防止雙重訂票 (Double Booking Prevention)
# ============================================
print_test "3" "防止雙重訂票"

# 第一次訂票（應該成功）
RESPONSE1=$(curl -s -X POST "$RESTATE_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -d "{\"ticketId\": \"$SEAT3\", \"userId\": \"test-user-3a\", \"paymentMethodId\": \"card_success\"}")

assert_contains "$RESPONSE1" "Booking Confirmed" "第一次訂票成功"

wait_a_bit

# 第二次訂票相同座位（應該失敗）
RESPONSE2=$(curl -s -X POST "$RESTATE_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -d "{\"ticketId\": \"$SEAT3\", \"userId\": \"test-user-3b\", \"paymentMethodId\": \"card_success\"}")

assert_contains "$RESPONSE2" "already sold" "第二次訂票被拒絕"

# ============================================
# 測試 4: 票券狀態查詢 (Get Handler)
# ============================================
print_test "4" "票券狀態查詢"

# 查詢新票券（應該是 AVAILABLE）
STATE=$(curl -s -X POST "$RESTATE_URL/Ticket/$SEAT4/get" \
    -H "Content-Type: application/json" -d '{}')

assert_contains "$STATE" "AVAILABLE" "新票券狀態為 AVAILABLE"
assert_contains "$STATE" "null" "新票券沒有預留者"

# ============================================
# 測試 5: 並發訂票 (Concurrency Test)
# ============================================
print_test "5" "並發訂票測試 (序列化保護)"

# 同時發送 3 個請求訂相同座位
SEAT_ID="$SEAT5"
TMP5=$(mktemp -d)
RESP_FILES=("$TMP5/res-1" "$TMP5/res-2" "$TMP5/res-3")

curl -s -X POST "$RESTATE_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -d "{\"ticketId\": \"$SEAT_ID\", \"userId\": \"concurrent-user-1\", \"paymentMethodId\": \"card_success\"}" > "${RESP_FILES[0]}" &
PID1=$!

curl -s -X POST "$RESTATE_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -d "{\"ticketId\": \"$SEAT_ID\", \"userId\": \"concurrent-user-2\", \"paymentMethodId\": \"card_success\"}" > "${RESP_FILES[1]}" &
PID2=$!

curl -s -X POST "$RESTATE_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -d "{\"ticketId\": \"$SEAT_ID\", \"userId\": \"concurrent-user-3\", \"paymentMethodId\": \"card_success\"}" > "${RESP_FILES[2]}" &
PID3=$!

# 等待所有請求完成
wait $PID1
wait $PID2
wait $PID3

sleep 2

# 驗證最終狀態：應該只有一個用戶成功訂票
STATE=$(curl -s -X POST "$RESTATE_URL/Ticket/$SEAT_ID/get" \
    -H "Content-Type: application/json" -d '{}')

assert_contains "$STATE" "SOLD" "並發情況下票券被正確標記為 SOLD"

# 失敗型別分布斷言：區分「正確擋下」與「因其他錯誤失敗」——
# 恰好 1 個 "Booking Confirmed"，其餘 2 個必須是正確的拒絕類型
# （"currently reserved"：仍在保留窗口被擋；"already sold"：已售出被擋）
CONFIRMED_COUNT=0
VALID_REJECT_COUNT=0
UNEXPECTED_COUNT=0
UNEXPECTED_BODY=""
for f in "${RESP_FILES[@]}"; do
    BODY=$(cat "$f" 2>/dev/null || true)
    if echo "$BODY" | grep -q "Booking Confirmed"; then
        CONFIRMED_COUNT=$((CONFIRMED_COUNT + 1))
    elif echo "$BODY" | grep -qE "currently reserved|already sold"; then
        VALID_REJECT_COUNT=$((VALID_REJECT_COUNT + 1))
    else
        UNEXPECTED_COUNT=$((UNEXPECTED_COUNT + 1))
        UNEXPECTED_BODY="$UNEXPECTED_BODY
$BODY"
    fi
done

if [ "$CONFIRMED_COUNT" -eq 1 ] && [ "$VALID_REJECT_COUNT" -eq 2 ] && [ "$UNEXPECTED_COUNT" -eq 0 ]; then
    echo -e "${COLOR_GREEN}✓ PASS${COLOR_NC}: 並發失敗型別分布正確 (1 個 Booking Confirmed、2 個 reserved/already sold 拒絕)"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${COLOR_RED}✗ FAIL${COLOR_NC}: 並發失敗型別分布不正確（期望 1 confirmed + 2 正確拒絕；實際 $CONFIRMED_COUNT confirmed、$VALID_REJECT_COUNT 正確拒絕、$UNEXPECTED_COUNT 非預期）"
    echo -e "${COLOR_RED}非預期回應:$UNEXPECTED_BODY${COLOR_NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
fi

rm -rf "$TMP5"

# ============================================
# 測試 6: 支付閘道超時 (Gateway Timeout)
# ============================================
print_test "6" "支付閘道超時處理 (card_error)"

RESPONSE=$(curl -s -X POST "$RESTATE_URL/Checkout/process" \
    -H "Content-Type: application/json" \
    -d "{\"ticketId\": \"$SEAT6\", \"userId\": \"test-user-6\", \"paymentMethodId\": \"card_error\"}")

assert_contains "$RESPONSE" "Payment failed" "閘道超時返回錯誤"
assert_contains "$RESPONSE" "Gateway timeout" "錯誤訊息包含 'Gateway timeout'"

wait_a_bit

# 驗證補償邏輯
STATE=$(curl -s -X POST "$RESTATE_URL/Ticket/$SEAT6/get" \
    -H "Content-Type: application/json" -d '{}')

assert_contains "$STATE" "AVAILABLE" "超時後票券被釋放"

# ============================================
# 測試 7: 大量連續訂票 (Bulk Booking)
# ============================================
print_test "7" "大量連續訂票測試"

SUCCESS_COUNT=0
for i in {1..5}; do
    BULK_SEAT="${BULK_IDS[$((i - 1))]}"
    RESPONSE=$(curl -s -X POST "$RESTATE_URL/Checkout/process" \
        -H "Content-Type: application/json" \
        -d "{\"ticketId\": \"$BULK_SEAT\", \"userId\": \"bulk-user-$i\", \"paymentMethodId\": \"card_success\"}")
    
    if echo "$RESPONSE" | grep -q "Booking Confirmed"; then
        SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
    fi
    sleep 0.5
done

if [ "$SUCCESS_COUNT" -eq 5 ]; then
    echo -e "${COLOR_GREEN}✓ PASS${COLOR_NC}: 大量訂票成功 (5/5)"
    PASSED_TESTS=$((PASSED_TESTS + 1))
else
    echo -e "${COLOR_RED}✗ FAIL${COLOR_NC}: 大量訂票失敗 ($SUCCESS_COUNT/5)"
    FAILED_TESTS=$((FAILED_TESTS + 1))
fi

# ============================================
# 測試摘要
# ============================================
echo -e "\n${COLOR_BLUE}========================================${COLOR_NC}"
echo -e "${COLOR_BLUE}測試摘要${COLOR_NC}"
echo -e "${COLOR_BLUE}========================================${COLOR_NC}"
echo -e "總測試數: $TOTAL_TESTS"
echo -e "${COLOR_GREEN}通過: $PASSED_TESTS${COLOR_NC}"
echo -e "${COLOR_RED}失敗: $FAILED_TESTS${COLOR_NC}"

if [ "$FAILED_TESTS" -eq 0 ]; then
    echo -e "\n${COLOR_GREEN}🎉 所有測試通過！${COLOR_NC}\n"
    exit 0
else
    echo -e "\n${COLOR_RED}❌ 有測試失敗，請檢查上方詳細訊息${COLOR_NC}\n"
    exit 1
fi
