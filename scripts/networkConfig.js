import dydx from '@dydxprotocol/v4-client-js';

const { Network, IndexerConfig, ValidatorConfig } = dydx;

// Configure the network
const NETWORK = new Network(
  'mainnet',
  new IndexerConfig(
    'https://indexer.dydx.trade',
    'wss://indexer.dydx.trade',
  ),
  new ValidatorConfig(
    'https://dydx-rpc.publicnode.com:443',
    'dydx-mainnet-1',
    {
      CHAINTOKEN_DENOM: 'adydx',
      CHAINTOKEN_DECIMALS: 18,
      USDC_DENOM: 'ibc/8E27BA2D5493AF5636760E354E46004562C46AB7EC0CC4C1CA14E9E20E2545B5',
      USDC_GAS_DENOM: 'uusdc',
      USDC_DECIMALS: 6,
    },
  ),
);

export default NETWORK;