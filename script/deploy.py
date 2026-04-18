from moccasin.config import get_active_network
from moccasin.boa_tools import VyperContract
from src import AgentReputationOracle

CUSD_MAINNET   = "0x765DE816845861e75A25fCA122bb6898B8B1282a"
CUSD_ALFAJORES = "0x874069Fa1Eb16D44d622F2e0Ca25eeA172369bC1"

def moccasin_main() -> VyperContract:
    active_network = get_active_network()
    print(f"\n  Deploying AgentReputationOracle on {active_network.name}")

    cusd = CUSD_MAINNET if "mainnet" in active_network.name else CUSD_ALFAJORES

    oracle = AgentReputationOracle.deploy(cusd)

    print(f"  Contract : {oracle.address}")
    print(f"  cUSD     : {cusd}")
    print()
    print("  -> Paste oracle.address into app.js  ADDR.Oracle")
    return oracle.address
