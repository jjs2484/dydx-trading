import 'dotenv/config';
import dydx from '@dydxprotocol/v4-client-js';
import NETWORK from './networkConfig.js';

const { 
    LocalWallet,
    BECH32_PREFIX,
    CompositeClient,
    Network,
    SubaccountClient,
    IndexerConfig,
    ValidatorConfig,
    OrderSide,
    OrderType,
    OrderTimeInForce,
    OrderFlags
} = dydx;

// Fetch mnemonic from .env
const mnemonic = process.env.DYDX_MNEMONIC;
if (!mnemonic) {
    throw new Error('DYDX_MNEMONIC not defined in environment variables');
}

// Helper function to count decimals
function countDecimals(value) {
    // Convert to string
    let valueStr = value.toString();
  
    // If scientific notation detected (e.g. '1e-10', '2.5E+4', etc.),
    // Convert to a full decimal.
    if (/[eE]/.test(valueStr)) {
      // Increase maximumFractionDigits if you have extremely small or large exponents
      valueStr = value.toLocaleString('fullwide', { 
        useGrouping: false,
        maximumFractionDigits: 18 
      });
    }
  
    // Convert back to number for the integer check
    const numericValue = Number(valueStr);
  
    // If the numeric value is an integer (e.g. 1, 2.0, etc.), return 0
    if (Math.floor(numericValue) === numericValue) {
      return 0;
    }
  
    const decimalPart = valueStr.split('.')[1]; // Get the part after the decimal
    return decimalPart ? decimalPart.length : 0; // Count the digits after the decimal
}

// Cancel all open orders with retry logic
async function cancelAllOrders(maxRetries, delay, client, subaccount) {
    let attempts = 0;
    while (attempts < maxRetries) {
        try {
            const ordersResponse = await client.indexerClient.account.getSubaccountOrders(
                subaccount.address,
                subaccount.subaccountNumber
            );

            const openOrders = ordersResponse.filter(
                order => order.status === 'OPEN' || order.status === 'UNTRIGGERED'
            );

            if (!Array.isArray(openOrders) || openOrders.length === 0) {
                console.log('No open or untriggered orders to cancel.');
                return;
            }

            console.log(`Found ${openOrders.length} open/untriggered orders. Attempting to cancel...`);

            for (const order of openOrders) {
                console.log(`Canceling ${order.status.toLowerCase()} order with clientId: ${order.clientId}`);

                const clientId = Number(order.clientId);
                const orderFlags = Number(order.orderFlags);
                const clobPairId = order.ticker; // Use ticker string
                const goodTilBlock = 0;
                const goodTilBlockTime = 14 * 24 * 60 * 60; // 14 days from now

                try {
                    await client.cancelOrder(
                        subaccount,
                        clientId,
                        orderFlags,
                        clobPairId,
                        goodTilBlock,
                        goodTilBlockTime
                    );
                    console.log(`Order with clientId ${order.clientId} successfully canceled.`);
                } catch (error) {
                    console.error(`Failed to cancel order with clientId ${order.clientId}: ${error.message}`);
                }
            }

            // Wait before verifying if orders are canceled
            console.log(`Waiting ${delay / 1000} seconds before verifying cancellations...`);
            await new Promise(resolve => setTimeout(resolve, delay));

            // Verify if all orders are canceled
            const verifyOrdersResponse = await client.indexerClient.account.getSubaccountOrders(
                subaccount.address,
                subaccount.subaccountNumber
            );

            const remainingOrders = verifyOrdersResponse.filter(
                order => order.status === 'OPEN' || order.status === 'UNTRIGGERED'
            );

            if (remainingOrders.length === 0) {
                console.log('All orders successfully canceled.');
                return; // Exit the function if no remaining orders
            } else {
                console.log(`Retrying... ${remainingOrders.length} orders still open.`);
            }
        } catch (error) {
            console.error(`Error canceling orders: ${error.message}`);
        }

        attempts++;
        if (attempts === maxRetries) {
            throw new Error('Max retries reached. Failed to cancel all orders.');
        }
    }
}

// Close positions using reduce-only limit orders with retry logic
async function closePositionsWithLimitOrders(maxRetries, delay, client, subaccount) {
    let attempts = 0;
    while (attempts < maxRetries) {
        try {
            const positionsResponse = await client.indexerClient.account.getSubaccountPerpetualPositions(
                subaccount.address,
                subaccount.subaccountNumber
            );

            // Filter positions with size > 0
            const positions = (positionsResponse.positions || []).filter(pos => Math.abs(pos.size) > 0);

            if (!positions.length) {
                console.log('No open positions to close.');
                return;
            }

            for (const position of positions) {
                const side = position.size > 0 ? OrderSide.SELL : OrderSide.BUY;
                const absoluteSize = Math.abs(position.size);

                // Fetch market details
                const allMarkets = await client.indexerClient.markets.getPerpetualMarkets();
                const marketInfo = allMarkets.markets[position.market];
                if (!marketInfo) {
                    console.error(`Market details not found for ${position.market}`);
                    continue;
                }

                const tickSize = parseFloat(marketInfo.tickSize);
                const oraclePrice = parseFloat(marketInfo.oraclePrice);

                if (!oraclePrice || isNaN(oraclePrice) || !tickSize || isNaN(tickSize)) {
                    console.error(`Invalid market data for ${position.market}`);
                    continue;
                }

                // Adjust price
                const adjustedPrice = (side === OrderSide.SELL)
                    ? oraclePrice * 0.90 // Slightly below market for SELL
                    : oraclePrice * 1.10; // Slightly above market for BUY

                const tickDecimals = countDecimals(tickSize);
                const roundedPrice = parseFloat((Math.round(adjustedPrice / tickSize) * tickSize).toFixed(tickDecimals));

                console.log(`Placing reduce-only limit order for ${position.market}: size=${absoluteSize}, price=${roundedPrice}`);

                await client.placeOrder(
                    subaccount,
                    position.market,
                    OrderType.LIMIT,
                    side,
                    roundedPrice,
                    absoluteSize,
                    Date.now(),
                    OrderTimeInForce.IOC,
                    0, // goodTilBlock not needed for IOC
                    false, // postOnly
                    true // reduceOnly
                );
            }

            // Wait and recheck positions
            await new Promise(resolve => setTimeout(resolve, delay));
            const newPositionsResponse = await client.indexerClient.account.getSubaccountPerpetualPositions(
                subaccount.address,
                subaccount.subaccountNumber
            );

            const newPositions = newPositionsResponse.positions || [];
            const openPositions = newPositions.filter(pos => Math.abs(pos.size) > 0);

            if (openPositions.length === 0) {
                console.log('All positions closed successfully.');
                return;
            } else {
                console.log('Some positions are still open.');
            }

        } catch (error) {
            console.error(`Error closing positions: ${error.message}`);
        }

        attempts++;
        if (attempts < maxRetries) {
            console.log('Retrying to close positions...');
        } else {
            throw new Error('Max retries reached. Failed to close all positions.');
        }
    }
}

// Main execution
(async () => {
    try {
        const wallet = await LocalWallet.fromMnemonic(mnemonic, BECH32_PREFIX);
        const client = await CompositeClient.connect(NETWORK);
        const subaccount = new SubaccountClient(wallet, 0);

        const maxCloseRetries = 5;
        const closeRetryDelay = 14000; // 14 seconds
        await cancelAllOrders(maxCloseRetries, closeRetryDelay, client, subaccount);
        await closePositionsWithLimitOrders(maxCloseRetries, closeRetryDelay, client, subaccount);

        console.log('All operations completed successfully.');
    } catch (error) {
        console.error(`Error executing script: ${error.message}`);
    }
})();
