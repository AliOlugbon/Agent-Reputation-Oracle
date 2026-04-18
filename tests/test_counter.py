"""
tests/test_oracle.py  -  titanoboa test suite for AgentReputationOracle.
Run: mox test  |  pytest tests/
"""
import pytest
import boa
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak

MIN_STAKE = 10 * 10**18


# ════════════════════════════════════════════════════════════════
# IDENTITY
# ════════════════════════════════════════════════════════════════

class TestIdentity:

    def test_register(self, oracle, admin, agent_1):
        with boa.env.prank(admin):
            oracle.registerAgent(agent_1, '{"name":"DeFi Scout","emoji":"🤖"}')
        info = oracle.getAgent(agent_1)
        assert info[0] == admin       # owner
        assert info[3] is True        # active
        assert oracle.isRegistered(agent_1)

    def test_duplicate_reverts(self, oracle, admin, agent_1):
        with boa.env.prank(admin):
            oracle.registerAgent(agent_1, "meta")
        with pytest.raises(Exception, match="already registered"):
            with boa.env.prank(admin):
                oracle.registerAgent(agent_1, "meta2")

    def test_zero_address_reverts(self, oracle, admin):
        with pytest.raises(Exception, match="zero address"):
            with boa.env.prank(admin):
                oracle.registerAgent("0x" + "0"*40, "meta")

    def test_deactivate(self, oracle, admin, agent_1, registered_agent):
        with boa.env.prank(admin):
            oracle.deactivateAgent(agent_1)
        assert not oracle.isRegistered(agent_1)


# ════════════════════════════════════════════════════════════════
# REPUTATION  (EIP-712)
# ════════════════════════════════════════════════════════════════

def _sign(oracle_addr, chain_id, account, agent, score, tag, comment, nonce):
    domain = {
        "name": "AgentReputationOracle", "version": "1",
        "chainId": chain_id, "verifyingContract": oracle_addr,
    }
    types = {"Feedback": [
        {"name": "agent",   "type": "address"},
        {"name": "score",   "type": "uint8"},
        {"name": "tag",     "type": "bytes32"},
        {"name": "comment", "type": "string"},
        {"name": "nonce",   "type": "uint256"},
    ]}
    msg = encode_typed_data(domain, types, "Feedback",
        {"agent": agent, "score": score, "tag": tag,
         "comment": comment, "nonce": nonce})
    return account.sign_message(msg).signature


class TestReputation:

    def test_initial_zero(self, oracle, agent_1):
        assert oracle.getReputation(agent_1) == 0
        assert oracle.getFeedbackCount(agent_1) == 0

    def test_submit_feedback(self, oracle, registered_agent, agent_1):
        acc = Account.create()
        tag = keccak(b"defi_trading")
        sig = _sign(oracle.address, boa.env.chain_id, acc,
                    agent_1, 80, tag, "Great!", 0)
        with boa.env.prank(acc.address):
            oracle.submitFeedback(agent_1, 80, tag, "Great!", sig)
        assert oracle.getReputation(agent_1) == 80
        assert oracle.getFeedbackCount(agent_1) == 1
        assert oracle.getReviewerNonce(acc.address) == 1

    def test_average_two_reviews(self, oracle, registered_agent, agent_1):
        acc = Account.create()
        tag = keccak(b"defi_trading")
        for i, s in enumerate([60, 80]):
            sig = _sign(oracle.address, boa.env.chain_id, acc,
                        agent_1, s, tag, f"rev{i}", i)
            with boa.env.prank(acc.address):
                oracle.submitFeedback(agent_1, s, tag, f"rev{i}", sig)
        assert oracle.getReputation(agent_1) == 70   # (60+80)/2

    def test_score_over_100_reverts(self, oracle, registered_agent, agent_1):
        acc = Account.create()
        tag = keccak(b"defi_trading")
        sig = _sign(oracle.address, boa.env.chain_id, acc,
                    agent_1, 101, tag, "", 0)
        with pytest.raises(Exception, match="score > 100"):
            with boa.env.prank(acc.address):
                oracle.submitFeedback(agent_1, 101, tag, "", sig)

    def test_bad_sig_reverts(self, oracle, registered_agent, agent_1, reviewer):
        tag = keccak(b"defi_trading")
        with pytest.raises(Exception, match="invalid signature"):
            with boa.env.prank(reviewer):
                oracle.submitFeedback(agent_1, 80, tag, "", b"\x00"*65)


# ════════════════════════════════════════════════════════════════
# VALIDATION
# ════════════════════════════════════════════════════════════════

class TestValidation:

    def test_validate_and_check(self, oracle, admin, registered_agent, agent_1):
        tag = keccak(b"defi_trading")
        with boa.env.prank(admin):
            oracle.validate(agent_1, tag, 0)
        assert oracle.isValid(agent_1, tag)

    def test_expiry(self, oracle, admin, registered_agent, agent_1):
        tag    = keccak(b"governance")
        future = boa.env.vm.patch.timestamp + 3600
        with boa.env.prank(admin):
            oracle.validate(agent_1, tag, future)
        assert oracle.isValid(agent_1, tag)
        boa.env.time_travel(seconds=3601)
        assert not oracle.isValid(agent_1, tag)

    def test_revoke(self, oracle, admin, registered_agent, agent_1):
        tag = keccak(b"bridge")
        with boa.env.prank(admin):
            oracle.validate(agent_1, tag, 0)
            oracle.revokeValidation(agent_1, tag)
        assert not oracle.isValid(agent_1, tag)

    def test_non_validator_reverts(self, oracle, registered_agent, agent_1, reviewer):
        tag = keccak(b"defi_trading")
        with pytest.raises(Exception, match="not a validator"):
            with boa.env.prank(reviewer):
                oracle.validate(agent_1, tag, 0)


# ════════════════════════════════════════════════════════════════
# STAKING
# ════════════════════════════════════════════════════════════════

class TestStaking:

    def _fund_and_stake(self, mock_cusd, oracle, admin, agent):
        with boa.env.prank(admin):
            mock_cusd.mint(agent, MIN_STAKE)
        with boa.env.prank(agent):
            mock_cusd.approve(oracle.address, MIN_STAKE)
            oracle.stake(MIN_STAKE)

    def test_stake(self, oracle, mock_cusd, admin, registered_agent, agent_1):
        self._fund_and_stake(mock_cusd, oracle, admin, agent_1)
        assert oracle.stakeOf(agent_1) == MIN_STAKE
        assert oracle.hasSufficientStake(agent_1)

    def test_unstake_full(self, oracle, mock_cusd, admin, registered_agent, agent_1):
        self._fund_and_stake(mock_cusd, oracle, admin, agent_1)
        with boa.env.prank(agent_1):
            oracle.unstake(MIN_STAKE)
        assert oracle.stakeOf(agent_1) == 0
        assert not oracle.hasSufficientStake(agent_1)

    def test_below_min_reverts(self, oracle, mock_cusd, admin, registered_agent, agent_1):
        small = 5 * 10**18
        with boa.env.prank(admin):
            mock_cusd.mint(agent_1, small)
        with boa.env.prank(agent_1):
            mock_cusd.approve(oracle.address, small)
            with pytest.raises(Exception, match="below minimum"):
                oracle.stake(small)

    def test_not_registered_reverts(self, oracle, mock_cusd, admin, agent_2):
        with boa.env.prank(admin):
            mock_cusd.mint(agent_2, MIN_STAKE)
        with boa.env.prank(agent_2):
            mock_cusd.approve(oracle.address, MIN_STAKE)
            with pytest.raises(Exception, match="not registered"):
                oracle.stake(MIN_STAKE)


# ════════════════════════════════════════════════════════════════
# COMPOSITE SCORE
# ════════════════════════════════════════════════════════════════

class TestOracleScore:

    def test_zero_for_unregistered(self, oracle, agent_1):
        s, r, v, st = oracle.getDetailedScore(agent_1)
        assert s == 0

    def test_full_score(self, oracle, mock_cusd, admin, agent_1):
        # 1. Register
        with boa.env.prank(admin):
            oracle.registerAgent(agent_1, '{"name":"Full Score Bot","emoji":"🏆"}')

        # 2. Feedback -> rep = 80
        acc = Account.create()
        tag = keccak(b"defi_trading")
        sig = _sign(oracle.address, boa.env.chain_id, acc, agent_1, 80, tag, "ok", 0)
        with boa.env.prank(acc.address):
            oracle.submitFeedback(agent_1, 80, tag, "ok", sig)

        # 3. Validate one tag
        with boa.env.prank(admin):
            oracle.validate(agent_1, tag, 0)

        # 4. Stake cUSD
        with boa.env.prank(admin):
            mock_cusd.mint(agent_1, MIN_STAKE)
        with boa.env.prank(agent_1):
            mock_cusd.approve(oracle.address, MIN_STAKE)
            oracle.stake(MIN_STAKE)

        # 5. Score = (80*70 + 10*20 + 100*10) / 100 = (5600+200+1000)/100 = 68
        score, rep, val, stake_b = oracle.getDetailedScore(agent_1)
        assert rep     == 80
        assert val     == 10    # 1 tag * BONUS_PER_TAG(10)
        assert stake_b == 100
        assert score   == 68
