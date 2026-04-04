import json
import math
import os
import sys
import uuid
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from alpaca.trading.client import TradingClient
from alpaca.trading.requests import (
    MarketOrderRequest,
    StopLossRequest,
    TakeProfitRequest,
)
from alpaca.trading.enums import OrderSide, TimeInForce, OrderClass
from alpaca.data.historical.stock import StockHistoricalDataClient
from alpaca.data.historical.crypto import CryptoHistoricalDataClient
from alpaca.data.requests import StockLatestQuoteRequest, CryptoLatestQuoteRequest


# ==========================================
# USER SETTINGS
# ==========================================
PAPER = True

# Simulated real-money portfolio
SIMULATED_PORTFOLIO_VALUE = 1000.00

# Risk model — no max risk cap
RISK_PER_TRADE_PCT = 1.0        # no cap
MAX_POSITION_PCT = 1.0          # no position size limit
MIN_CASH_RESERVE_PCT = 0.0      # no cash reserve required
MAX_OPEN_TRADES = 20

# Strategy / execution defaults
# For crypto use slash format: "BTC/USD", "ETH/USD", "SOL/USD"
# For stocks use ticker: "AAPL", "TSLA", etc.
SYMBOL = "BTC/USD"

# Stop-loss / take-profit — crypto defaults are wider
STOP_LOSS_PCT = 0.10            # 10% for crypto (5% for stocks)
TAKE_PROFIT_PCT = 0.20          # 20% for crypto (10% for stocks)


def is_crypto(symbol: str) -> bool:
    return "/" in symbol

# Bot identity
BOT_PREFIX = "alexbot"
LEDGER_PATH = Path("bot_trade_ledger.json")


# ==========================================
# DATA STRUCTURES
# ==========================================
@dataclass
class RiskResult:
    allowed: bool
    reason: str
    symbol: str
    entry_price: float = 0.0
    stop_loss: float = 0.0
    take_profit: float = 0.0
    risk_per_share: float = 0.0
    allowed_dollar_risk: float = 0.0
    qty: float = 0.0          # float to support fractional crypto quantities
    position_cost: float = 0.0
    simulated_cash_available: float = 0.0
    simulated_cash_remaining: float = 0.0
    open_trades: int = 0
    simulated_deployed_capital: float = 0.0


# ==========================================
# ENV / CLIENTS
# ==========================================
def require_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def round_money(x: float) -> float:
    return round(float(x), 2)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_clients():
    api_key = require_env("ALPACA_API_KEY")
    secret_key = require_env("ALPACA_SECRET_KEY")

    trading_client = TradingClient(api_key, secret_key, paper=PAPER)
    stock_data_client = StockHistoricalDataClient(api_key, secret_key)
    crypto_data_client = CryptoHistoricalDataClient(api_key, secret_key)

    return trading_client, stock_data_client, crypto_data_client


# ==========================================
# LEDGER HELPERS
# ==========================================
def load_ledger() -> Dict[str, Any]:
    if not LEDGER_PATH.exists():
        return {"trades": []}

    with open(LEDGER_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def save_ledger(data: Dict[str, Any]) -> None:
    with open(LEDGER_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


def make_client_order_id(symbol: str) -> str:
    """
    Keep it unique. Alpaca requires unique active client_order_id values.
    """
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    short_id = uuid.uuid4().hex[:8]
    return f"{BOT_PREFIX}-{symbol}-{ts}-{short_id}"


def record_new_trade(
    ledger: Dict[str, Any],
    client_order_id: str,
    symbol: str,
    qty: int,
    entry_estimate: float,
    stop_loss: float,
    take_profit: float,
    position_cost_estimate: float,
) -> None:
    ledger["trades"].append(
        {
            "client_order_id": client_order_id,
            "symbol": symbol,
            "qty": qty,
            "entry_estimate": round_money(entry_estimate),
            "stop_loss": round_money(stop_loss),
            "take_profit": round_money(take_profit),
            "position_cost_estimate": round_money(position_cost_estimate),
            "status": "submitted",
            "submitted_at": utc_now_iso(),
            "alpaca_order_id": None,
            "filled_avg_price": None,
            "filled_qty": None,
            "closed_at": None,
            "closed_reason": None,
        }
    )


def find_trade_by_client_order_id(ledger: Dict[str, Any], client_order_id: str) -> Optional[Dict[str, Any]]:
    for trade in ledger.get("trades", []):
        if trade["client_order_id"] == client_order_id:
            return trade
    return None


# ==========================================
# MARKET DATA
# ==========================================
def get_latest_entry_price(
    stock_data_client: StockHistoricalDataClient,
    crypto_data_client: CryptoHistoricalDataClient,
    symbol: str,
) -> float:
    if is_crypto(symbol):
        req = CryptoLatestQuoteRequest(symbol_or_symbols=symbol)
        quotes = crypto_data_client.get_crypto_latest_quote(req)
        quote = quotes[symbol]
    else:
        req = StockLatestQuoteRequest(symbol_or_symbols=symbol)
        quotes = stock_data_client.get_stock_latest_quote(req)
        quote = quotes[symbol]

    # Conservative estimate for a market BUY
    if quote.ask_price is not None and quote.ask_price > 0:
        return float(quote.ask_price)

    if quote.bid_price is not None and quote.bid_price > 0:
        return float(quote.bid_price)

    raise RuntimeError(f"Could not get a usable latest quote for {symbol}")


# ==========================================
# ALPACA / RECONCILIATION HELPERS
# ==========================================
def get_real_account_snapshot(trading_client: TradingClient) -> Dict[str, float]:
    account = trading_client.get_account()
    return {
        "real_equity": float(account.equity),
        "real_cash": float(account.cash),
        "buying_power": float(account.buying_power),
    }


def get_position_for_symbol(trading_client: TradingClient, symbol: str):
    """
    Returns Alpaca position object for symbol if open, else None.
    """
    try:
        return trading_client.get_open_position(symbol)
    except Exception:
        return None


def reconcile_ledger_with_alpaca(trading_client: TradingClient, ledger: Dict[str, Any]) -> None:
    """
    For each bot trade:
    - try fetching the order by client_order_id
    - update fill info when available
    - detect whether the symbol position is still open
    - mark closed if no open position remains for that symbol
    """
    for trade in ledger.get("trades", []):
        if not trade["client_order_id"].startswith(BOT_PREFIX):
            continue

        try:
            order = trading_client.get_order_by_client_id(trade["client_order_id"])
            trade["alpaca_order_id"] = str(order.id)
            trade["status"] = str(order.status)

            if getattr(order, "filled_avg_price", None) is not None:
                trade["filled_avg_price"] = round_money(order.filled_avg_price)

            if getattr(order, "filled_qty", None) is not None:
                try:
                    trade["filled_qty"] = float(order.filled_qty)
                except Exception:
                    trade["filled_qty"] = None

        except Exception:
            # Keep local record; do not crash reconciliation
            pass

        # If the trade was filled before, check whether position is still open
        pos = get_position_for_symbol(trading_client, trade["symbol"])
        if pos is None:
            # Only mark closed if it had previously been a filled/open-ish trade
            if trade["status"] not in ("submitted", "new", "accepted", "pending_new"):
                if trade["closed_at"] is None:
                    trade["closed_at"] = utc_now_iso()
                    trade["closed_reason"] = "position_no_longer_open"
                    if trade["status"] not in ("canceled", "rejected", "expired"):
                        trade["status"] = "closed"


def get_bot_open_trades(ledger: Dict[str, Any]) -> List[Dict[str, Any]]:
    open_statuses = {
        "submitted",
        "new",
        "accepted",
        "pending_new",
        "partially_filled",
        "filled",
    }

    results = []
    for trade in ledger.get("trades", []):
        if not trade["client_order_id"].startswith(BOT_PREFIX):
            continue
        if trade.get("closed_at") is None and trade.get("status") in open_statuses:
            results.append(trade)

    return results


def get_bot_simulated_deployed_capital(ledger: Dict[str, Any]) -> float:
    total = 0.0
    for trade in get_bot_open_trades(ledger):
        # Prefer actual fill value if available, else estimate
        if trade.get("filled_avg_price") is not None and trade.get("filled_qty") is not None:
            total += float(trade["filled_avg_price"]) * float(trade["filled_qty"])
        else:
            total += float(trade["position_cost_estimate"])
    return round_money(total)


# ==========================================
# RISK ENGINE
# ==========================================
def calculate_trade_plan(
    symbol: str,
    entry_price: float,
    simulated_portfolio_value: float,
    current_deployed_capital: float,
    open_trades: int,
    stop_loss_pct: float,
    take_profit_pct: float,
) -> RiskResult:
    if entry_price <= 0:
        return RiskResult(False, "Invalid entry price.", symbol)

    if open_trades >= MAX_OPEN_TRADES:
        return RiskResult(
            False,
            "Maximum bot-managed open trades reached.",
            symbol,
            open_trades=open_trades,
            simulated_deployed_capital=round_money(current_deployed_capital),
        )

    stop_loss = entry_price * (1 - stop_loss_pct)
    take_profit = entry_price * (1 + take_profit_pct)
    risk_per_share = entry_price - stop_loss

    if risk_per_share <= 0:
        return RiskResult(False, "Invalid stop-loss calculation.", symbol, entry_price=entry_price)

    allowed_dollar_risk = simulated_portfolio_value * RISK_PER_TRADE_PCT

    # Crypto supports fractional quantities; stocks require whole shares
    crypto = is_crypto(symbol)
    CRYPTO_QTY_PRECISION = 6  # decimal places for crypto qty

    def size_qty(raw: float) -> float:
        if crypto:
            return round(raw, CRYPTO_QTY_PRECISION)
        return math.floor(raw)

    qty_by_risk = size_qty(allowed_dollar_risk / risk_per_share)

    max_position_value = simulated_portfolio_value * MAX_POSITION_PCT
    qty_by_position_cap = size_qty(max_position_value / entry_price)

    min_cash_reserve = simulated_portfolio_value * MIN_CASH_RESERVE_PCT
    simulated_cash_available = simulated_portfolio_value - min_cash_reserve - current_deployed_capital
    qty_by_cash = size_qty(simulated_cash_available / entry_price)

    qty = min(qty_by_risk, qty_by_position_cap, qty_by_cash)

    min_qty = 0.000001 if crypto else 1

    if simulated_cash_available <= 0:
        return RiskResult(
            False,
            "No simulated cash available after reserve rule.",
            symbol,
            entry_price=round_money(entry_price),
            stop_loss=round_money(stop_loss),
            take_profit=round_money(take_profit),
            risk_per_share=round_money(risk_per_share),
            allowed_dollar_risk=round_money(allowed_dollar_risk),
            simulated_cash_available=round_money(simulated_cash_available),
            open_trades=open_trades,
            simulated_deployed_capital=round_money(current_deployed_capital),
        )

    if qty < min_qty:
        return RiskResult(
            False,
            "Trade too large for the simulated account/risk rules.",
            symbol,
            entry_price=round_money(entry_price),
            stop_loss=round_money(stop_loss),
            take_profit=round_money(take_profit),
            risk_per_share=round_money(risk_per_share),
            allowed_dollar_risk=round_money(allowed_dollar_risk),
            simulated_cash_available=round_money(simulated_cash_available),
            open_trades=open_trades,
            simulated_deployed_capital=round_money(current_deployed_capital),
        )

    position_cost = qty * entry_price
    simulated_cash_remaining = simulated_cash_available - position_cost

    return RiskResult(
        True,
        "Trade passes simulated risk rules.",
        symbol=symbol,
        entry_price=round_money(entry_price),
        stop_loss=round_money(stop_loss),
        take_profit=round_money(take_profit),
        risk_per_share=round_money(risk_per_share),
        allowed_dollar_risk=round_money(allowed_dollar_risk),
        qty=qty,
        position_cost=round_money(position_cost),
        simulated_cash_available=round_money(simulated_cash_available),
        simulated_cash_remaining=round_money(simulated_cash_remaining),
        open_trades=open_trades,
        simulated_deployed_capital=round_money(current_deployed_capital),
    )


# ==========================================
# ORDER SUBMISSION
# ==========================================
def submit_bracket_order(
    trading_client: TradingClient,
    symbol: str,
    qty: float,
    stop_loss: float,
    take_profit: float,
    client_order_id: str,
):
    # Crypto trades 24/7 — GTC keeps the bracket alive; stocks use DAY
    tif = TimeInForce.GTC if is_crypto(symbol) else TimeInForce.DAY

    order_data = MarketOrderRequest(
        symbol=symbol,
        qty=qty,
        side=OrderSide.BUY,
        time_in_force=tif,
        order_class=OrderClass.BRACKET,
        take_profit=TakeProfitRequest(limit_price=take_profit),
        stop_loss=StopLossRequest(stop_price=stop_loss),
        client_order_id=client_order_id,
    )
    return trading_client.submit_order(order_data=order_data)


# ==========================================
# DISPLAY
# ==========================================
def print_summary(account_snapshot: Dict[str, float], risk: RiskResult) -> None:
    print("\n========== ACCOUNT ==========")
    print(f"Real Alpaca equity:          ${round_money(account_snapshot['real_equity'])}")
    print(f"Real Alpaca cash:            ${round_money(account_snapshot['real_cash'])}")
    print(f"Real Alpaca buying power:    ${round_money(account_snapshot['buying_power'])}")
    print(f"Simulated portfolio value:   ${round_money(SIMULATED_PORTFOLIO_VALUE)}")

    print("\n========== RISK ==========")
    print(f"Allowed:                     {risk.allowed}")
    print(f"Reason:                      {risk.reason}")
    print(f"Symbol:                      {risk.symbol}")
    print(f"Entry price:                 ${risk.entry_price}")
    print(f"Stop loss:                   ${risk.stop_loss}")
    print(f"Take profit:                 ${risk.take_profit}")
    print(f"Risk/share:                  ${risk.risk_per_share}")
    print(f"Allowed $ risk:              ${risk.allowed_dollar_risk}")
    qty_display = risk.qty if is_crypto(risk.symbol) else int(risk.qty)
    print(f"Qty:                         {qty_display}")
    print(f"Position cost:               ${risk.position_cost}")
    print(f"Bot open trades:             {risk.open_trades}")
    print(f"Bot deployed capital:        ${risk.simulated_deployed_capital}")
    print(f"Sim cash available:          ${risk.simulated_cash_available}")
    print(f"Sim cash remaining:          ${risk.simulated_cash_remaining}")


# ==========================================
# MAIN
# ==========================================
def main():
    trading_client, stock_data_client, crypto_data_client = get_clients()

    account_snapshot = get_real_account_snapshot(trading_client)

    ledger = load_ledger()

    # Update local ledger with latest Alpaca order/position state
    reconcile_ledger_with_alpaca(trading_client, ledger)
    save_ledger(ledger)

    bot_open_trades = get_bot_open_trades(ledger)
    deployed_capital = get_bot_simulated_deployed_capital(ledger)

    entry_price = get_latest_entry_price(stock_data_client, crypto_data_client, SYMBOL)

    risk = calculate_trade_plan(
        symbol=SYMBOL,
        entry_price=entry_price,
        simulated_portfolio_value=SIMULATED_PORTFOLIO_VALUE,
        current_deployed_capital=deployed_capital,
        open_trades=len(bot_open_trades),
        stop_loss_pct=STOP_LOSS_PCT,
        take_profit_pct=TAKE_PROFIT_PCT,
    )

    print_summary(account_snapshot, risk)

    if not risk.allowed:
        print("\nNo order submitted.")
        return

    # Real Alpaca sanity check
    if risk.position_cost > account_snapshot["real_cash"]:
        print("\nBlocked: real Alpaca paper cash is lower than required position cost.")
        return

    client_order_id = make_client_order_id(SYMBOL)

    # Record locally BEFORE submission attempt so you can inspect intent even if submission errors
    record_new_trade(
        ledger=ledger,
        client_order_id=client_order_id,
        symbol=SYMBOL,
        qty=risk.qty,
        entry_estimate=risk.entry_price,
        stop_loss=risk.stop_loss,
        take_profit=risk.take_profit,
        position_cost_estimate=risk.position_cost,
    )
    save_ledger(ledger)

    try:
        order = submit_bracket_order(
            trading_client=trading_client,
            symbol=SYMBOL,
            qty=risk.qty,
            stop_loss=risk.stop_loss,
            take_profit=risk.take_profit,
            client_order_id=client_order_id,
        )
    except Exception as exc:
        trade = find_trade_by_client_order_id(ledger, client_order_id)
        if trade:
            trade["status"] = "submission_failed"
            trade["closed_at"] = utc_now_iso()
            trade["closed_reason"] = f"submission_error: {exc}"
            save_ledger(ledger)
        raise

    trade = find_trade_by_client_order_id(ledger, client_order_id)
    if trade:
        trade["alpaca_order_id"] = str(order.id)
        trade["status"] = str(order.status)
        save_ledger(ledger)

    print("\n========== ORDER SUBMITTED ==========")
    print(f"Client Order ID:             {client_order_id}")
    print(f"Order ID:                    {order.id}")
    print(f"Status:                      {order.status}")
    print(f"Symbol:                      {order.symbol}")
    print(f"Qty:                         {order.qty}")
    print(f"Ledger file:                 {LEDGER_PATH.resolve()}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        sys.exit(1)