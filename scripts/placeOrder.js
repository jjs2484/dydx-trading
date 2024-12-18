import 'dotenv/config';
import fs from 'fs/promises';
import dydx from '@dydxprotocol/v4-client-js';
import NETWORK from './networkConfig.js';

const { 
  LocalWallet,
  BECH32_PREFIX,
  CompositeClient,
  Network,
  SubaccountClient,
  OrderExecution,
  OrderSide,
  OrderTimeInForce,
  OrderType,
  NodeClient,
  StatefulOrderTimeWindow,
  IndexerConfig,
  ValidatorConfig
} = dydx;

// Fetch mnemonic from .env
const mnemonic = process.env.DYDX_MNEMONIC;
if (!mnemonic) {
  throw new Error('MNEMONIC not defined in environment variables');
}

// Helper function to round values
function roundToTick(value, tick) {
  return Math.round(value / tick) * tick;
}

// Helper function to count decimals
function countDecimals(value) {
  if (Math.floor(value) === value) return 0; // No decimals
  const valueStr = value.toString(); // Convert to string
  const decimalPart = valueStr.split('.')[1]; // Get the part after the decimal
  return decimalPart ? decimalPart.length : 0; // Count the digits after the decimal
}

(async () => {
  try {
    // Read and parse temp.json
    const tempData = await fs.readFile('./tempfile.json', 'utf8');
    const { coin, signal, trigger_price_override, allocation, leverage } = JSON.parse(tempData);

    // Create client
    const client = await CompositeClient.connect(NETWORK);
    // const client = await CompositeClient.connect(Network.testnet());

    // Fetch coin data
    const ticker = coin;  // From temp.json
    const allMarketsData = await client.indexerClient.markets.getPerpetualMarkets();
    const coinMarket = allMarketsData.markets[ticker];
    if (!coinMarket) {
      throw new Error(`Market data for ${ticker} not found`);
    }
    const coinPrice = coinMarket.oraclePrice;

    console.log('Fetched Coin Price:', coinPrice);

    // Fetch market parameters (tickSize, stepSize) from perpetualMarkets
    const marketInfo = allMarketsData.markets[ticker];
    const tickSize = parseFloat(marketInfo.tickSize); // For price increments
    const stepSize = parseFloat(marketInfo.stepSize); // For size increments

    console.log('Tick size:', tickSize);
    console.log('Step size:', stepSize);

    // Create wallet, subaccount, and address
    const wallet = await LocalWallet.fromMnemonic(mnemonic, BECH32_PREFIX);
    const subaccount = new SubaccountClient(wallet, 0);
    const address = wallet.address;

    // Fetch subaccount data
    const subaccountInfo = await client.indexerClient.account.getSubaccount(address, 0);
    const freeCollateral = Number(subaccountInfo.subaccount.freeCollateral);

    // Collateral and leverage calculation
    const accountRatio = allocation; // From temp.json - amount of capital to use
    const leverageRatio = leverage; // From temp.json - leverage to use
    const usableUsd = freeCollateral * accountRatio;
    const notionalUsd = (usableUsd * leverageRatio) + usableUsd;

    // Convert USD to Coin using coinPrice
    let sizeInCoin = notionalUsd / coinPrice;

    // Round coin amount to stepSize increments
    const stepDecimals = countDecimals(stepSize);
    sizeInCoin = Math.round(sizeInCoin / stepSize) * stepSize;
    sizeInCoin = parseFloat(sizeInCoin.toFixed(stepDecimals));

    // Function to place market order with retry logic
    async function placeMarketOrderWithRetry(maxRetries, delay) {
      let attempts = 0;
      while (attempts < maxRetries) {
        try {
          const market = ticker;
          const type = OrderType.MARKET;
          const side = signal.toLowerCase() === 'buy' ? OrderSide.BUY : OrderSide.SELL; // From temp.json
          const timeInForce = OrderTimeInForce.IOK;
          const execution = OrderExecution.DEFAULT;
          const clientId = Date.now();
          const postOnly = false;
          const reduceOnly = false;
          const triggerPrice = null;
          let orderPrice = coinPrice * 1.1; // Adjusted up by 10% for BUY, down by 10% for SELL
          if (side === OrderSide.SELL) {
            orderPrice = coinPrice * 0.9;
          }
    
          // Round order price to tickSize increments
          const tickDecimals = countDecimals(tickSize);
          orderPrice = Math.round(orderPrice / tickSize) * tickSize;
          orderPrice = parseFloat(orderPrice.toFixed(tickDecimals));
    
          // Fetch the current block height for goodTilBlock
          const heightResponse = await client.indexerClient.utility.getHeight();
          const latestBlock = parseInt(heightResponse.height);
          const goodTilBlock = latestBlock + 20;
    
          console.log(`Placing ${signal.toUpperCase()} order for ${ticker} with size: ${sizeInCoin} Coins (~$${notionalUsd}), orderPrice: ${orderPrice}, clientId: ${clientId}`);
    
          const tx = await client.placeOrder(
            subaccount,
            market,
            type,
            side,
            orderPrice,
            sizeInCoin,
            clientId,
            timeInForce,
            goodTilBlock,
            execution,
            postOnly,
            reduceOnly,
            triggerPrice
          );
    
          if (tx) {
            console.log('Market order placed successfully:', tx);
    
            // Verify if the market order successfully opened a position
            await new Promise(resolve => setTimeout(resolve, delay)); // Wait before checking
            const positionsResponse = await client.indexerClient.account.getSubaccountPerpetualPositions(
              subaccount.address,
              subaccount.subaccountNumber
            );
    
            let marketOrderSuccess = false;
            const positions = positionsResponse.positions || [];
            for (const position of positions) {
              if (position.market === market && position.status === 'OPEN') {
                marketOrderSuccess = true;
                break;
              }
            }
    
            console.log('marketOrderSuccess:', marketOrderSuccess);
    
            if (marketOrderSuccess) {
              console.log(`Market order for ${ticker} successfully opened a position.`);
              return; // Exit the function as the market order succeeded
            } else {
              console.log(`Market order for ${ticker} did not open a position. Retrying...`);
            }
          } else {
            console.log('Market order failed to place. Retrying...');
          }
        } catch (error) {
          console.error('Error placing market order:', error.message);
        }
    
        attempts++;
        if (attempts === maxRetries) {
          console.error('Market order placement failed after maximum retries.');
          throw new Error('Max retries reached. Market order placement failed.');
        }
      }
    }

    // Function to place stop-loss order with retry logic
    async function placeStopLossOrderWithRetry(maxRetries, delay) {
      let attempts = 0;
      while (attempts < maxRetries) {
        try {
          // Stoploss order parameters
          const clientId2 = Date.now();
          const market2 = ticker;
          const type2 = OrderType.STOP_LIMIT;
          const side2 = signal.toLowerCase() === 'buy' ? OrderSide.SELL : OrderSide.BUY; // Opposite side for stop loss
          const timeInForce2 = OrderTimeInForce.IOC;
          const execution2 = OrderExecution.IOC;
          let price2 = trigger_price_override * 1.1; // From temp.json - Adjusted up by 10% for BUY, down by 10% for SELL
          if (signal.toLowerCase() === 'sell') {
            price2 = trigger_price_override * 0.9;
          }

          const size2 = sizeInCoin;
          const postOnly2 = false;
          const reduceOnly2 = true;
          let triggerPrice2 = trigger_price_override; // From temp.json

          // Adjust stop-loss price and trigger price to the nearest tick size
          const tickDecimals = countDecimals(tickSize);
          price2 = parseFloat((Math.round(price2 / tickSize) * tickSize).toFixed(tickDecimals));
          triggerPrice2 = parseFloat((Math.round(triggerPrice2 / tickSize) * tickSize).toFixed(tickDecimals));

          // Fetch the current block height and block time
          const heightResponse2 = await client.indexerClient.utility.getHeight();
          const currentBlockTime = Math.floor(new Date(heightResponse2.time).getTime() / 1000); // Current block time as UNIX timestamp

          // Stateful Order Time Window in seconds
          const statefulOrderTimeWindow = 14 * 24 * 60 * 60; // 14 days in seconds

          console.log(`Current Block Time: ${currentBlockTime} (UNIX timestamp)`);
          console.log(`Max Allowed GoodTilTime: ${statefulOrderTimeWindow} (in seconds)`);
          console.log(`Placing STOP-LOSS order with size: ${sizeInCoin} Coins at trigger price: ${triggerPrice2}, clientId2: ${clientId2}`);

          const stopLossOrder = await client.placeOrder(
            subaccount,
            market2,
            type2,
            side2,
            price2,
            size2,
            clientId2,
            timeInForce2,
            statefulOrderTimeWindow,
            execution2,
            postOnly2,
            reduceOnly2,
            triggerPrice2
          );

          if (stopLossOrder) {
            console.log('Stop loss order placed successfully:', stopLossOrder);

            // Verify if the stoploss order is in the list of open orders
            await new Promise(resolve => setTimeout(resolve, delay)); // Wait before checking
            const ordersResponse = await client.indexerClient.account.getSubaccountOrders(
              subaccount.address,
              subaccount.subaccountNumber
            );
      
            // console.log('stoploss ordersResponse:', ordersResponse);
            let stopLossOrderFound = false;
            for (const order of ordersResponse) {
              if (order.status === 'UNTRIGGERED' && order.ticker === market2 && order.type === 'STOP_LIMIT') {
                // console.log('Orders Response:', JSON.stringify(order, null, 2));
                stopLossOrderFound = true;
                break;
              }
            }

            console.log('stoploss stopLossOrderFound:', stopLossOrderFound);

            if (stopLossOrderFound) {
              console.log('Stop loss order is active.');
              return; // Exit the function as stop-loss is active
            } else {
              console.log('Stop loss order not active yet. Retrying...');
            }
          } else {
            console.log('Failed to place stop loss order. Retrying...');
          }

        } catch (error) {
          console.error('Error placing stop loss order:', error.message);
        }

        attempts++;
        if (attempts === maxRetries) {
          console.error('Stop loss order placement failed after maximum retries.');
          throw new Error('Max retries reached. Stop loss order placement failed.');
        }
      }
    }

    // Place market order with retry
    const maxOrderRetries = 3;
    const orderRetryDelay = 14000; // 14 seconds
    await placeMarketOrderWithRetry(maxOrderRetries, orderRetryDelay);

    // Place stop-loss order with retry
    const maxStopLossRetries = 3;
    const stopLossRetryDelay = 14000; // 14 seconds
    await placeStopLossOrderWithRetry(maxStopLossRetries, stopLossRetryDelay);

  } catch (error) {
    console.error('Error in main execution:', error.message);
    process.exit(1);
  }
})();