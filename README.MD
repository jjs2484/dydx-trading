# DYDX v4 TypeScript - Orders, Stoploss Orders, Close Orders, Close Positions

Places orders, stoploss orders, close orders, and close positions on the DYDX v4 blockchain. Includes order confirmations and time delayed retry logic for failed orders.

## JSON Input

Uses a JSON input file to configure the trading parameters dynamically. Below is an example JSON input structure with placeholders to guide you:

```shell
{
  "coin": "COIN-TICKER",            // The trading pair, ex "DOGE-USD" or "BTC-USD".
  "signal": "ACTION",               // The action to perform, ex "buy" or "sell".
  "trigger_price_override": 0.00,   // Trigger price for stop orders, ex 0.50.
  "allocation": 0.00,               // Funds to allocate for the trade, ex 0.75 - 75%.
  "leverage": 0.00                  // Leverage to use for the trade, ex 2.6 260% margin.
}
```

NPM tasks

```shell
npm install     // Install necessary packages
npm run order   // Places orders
npm run close   // Close all orders and positions
```