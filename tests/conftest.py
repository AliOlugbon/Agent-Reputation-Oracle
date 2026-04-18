"""tests/conftest.py  -  titanoboa fixtures for the consolidated contract."""
import pytest
import boa
from eth_account import Account


@pytest.fixture()
def admin():
    return boa.env.generate_address("admin")

@pytest.fixture()
def agent_1():
    return boa.env.generate_address("agent_1")

@pytest.fixture()
def agent_2():
    return boa.env.generate_address("agent_2")

@pytest.fixture()
def reviewer():
    return boa.env.generate_address("reviewer")


@pytest.fixture()
def mock_cusd(admin):
    """Minimal ERC-20 cUSD stand-in."""
    src = """
# @version ^0.4.0
name:        public(String[32])
symbol:      public(String[8])
decimals:    public(uint8)
totalSupply: public(uint256)
balanceOf:   public(HashMap[address, uint256])
allowance:   public(HashMap[address, HashMap[address, uint256]])
minter: address

event Transfer:
    sender: indexed(address); receiver: indexed(address); value: uint256
event Approval:
    owner: indexed(address); spender: indexed(address); value: uint256

@deploy
def __init__():
    self.name = "Mock cUSD"; self.symbol = "cUSD"; self.decimals = 18
    self.minter = msg.sender

@external
def mint(to: address, amount: uint256):
    assert msg.sender == self.minter
    self.totalSupply += amount; self.balanceOf[to] += amount
    log Transfer(empty(address), to, amount)

@external
def transfer(to: address, amount: uint256) -> bool:
    assert self.balanceOf[msg.sender] >= amount
    self.balanceOf[msg.sender] -= amount; self.balanceOf[to] += amount
    log Transfer(msg.sender, to, amount); return True

@external
def transferFrom(sender: address, recipient: address, amount: uint256) -> bool:
    assert self.allowance[sender][msg.sender] >= amount
    assert self.balanceOf[sender] >= amount
    self.allowance[sender][msg.sender] -= amount
    self.balanceOf[sender] -= amount; self.balanceOf[recipient] += amount
    log Transfer(sender, recipient, amount); return True

@external
def approve(spender: address, amount: uint256) -> bool:
    self.allowance[msg.sender][spender] = amount
    log Approval(msg.sender, spender, amount); return True
"""
    with boa.env.prank(admin):
        return boa.loads(src)


@pytest.fixture()
def oracle(admin, mock_cusd):
    with boa.env.prank(admin):
        return boa.load("src/AgentReputationOracle.vy", mock_cusd.address)


@pytest.fixture()
def registered_agent(admin, oracle, agent_1):
    with boa.env.prank(admin):
        oracle.registerAgent(agent_1, '{"name":"Test Agent","emoji":"🤖"}')
    return agent_1
