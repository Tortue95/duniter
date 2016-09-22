"use strict";

const co        = require('co');
const should    = require('should');
const toolbox   = require('./tools/toolbox');
const keyring   = require('../../app/lib/crypto/keyring');
const blockProver = require('../../app/lib/computation/blockProver');

/***
conf.medianTimeBlocks
conf.rootoffset
conf.cpu

keyring from Key
***/

const intermediateProofs = [];

const prover = blockProver({
  push: (data) => intermediateProofs.push(data)
});

prover.setConfDAL({
    cpu: 1.0 // 80%
  },
  null,
  keyring.Key(
  'HgTTJLAQ5sqfknMq7yLPZbehtuLSsKj9CxWN7k8QvYJd',
  '51w4fEShBk1jCMauWu4mLpmDVfHksKmWcygpxriqCEZizbtERA6de4STKRkQBpxmMUwsKXRjSzuQ8ECwmqN1u2DP'
));

const now = 1474382274 * 1000;
const MUST_START_WITH_A_ZERO = 16;
const MUST_START_WITH_SEVERAL_ZEROS = 48;

describe("Proof-of-work", function() {

  it('should be able to find an easy PoW', () => co(function*() {
    let block = yield prover.prove({
      issuer: 'HgTTJLAQ5sqfknMq7yLPZbehtuLSsKj9CxWN7k8QvYJd',
      number: 2
    }, MUST_START_WITH_SEVERAL_ZEROS, now);
    block.hash.should.match(/^0/);
    intermediateProofs.length.should.be.greaterThan(1);
    intermediateProofs[intermediateProofs.length - 2].pow.should.have.property('found').equal(false);
    intermediateProofs[intermediateProofs.length - 1].pow.should.have.property('found').equal(true);
    intermediateProofs[intermediateProofs.length - 1].pow.should.have.property('hash').equal(block.hash);
  }));

  it('should be possible to make the prover make us wait until we trigger it again', () => co(function*() {
    let waitPromise = prover.waitForNewAsking();
    return Promise.all([
      waitPromise,
      co(function*() {
        yield new Promise((resolve) => setTimeout(resolve, 10));
        yield prover.prove({
          issuer: 'HgTTJLAQ5sqfknMq7yLPZbehtuLSsKj9CxWN7k8QvYJd',
          number: 2
        }, MUST_START_WITH_A_ZERO, now);
      })
    ]);
  }));

  it('should be able to cancel a proof-of-work on other PoW receival', () => co(function*() {
    const now = 1474464481;
    const res = yield toolbox.simpleNetworkOf2NodesAnd2Users({
      powMin: 48
    }), s1 = res.s1, s2 = res.s2;
    yield s1.commit({
      time: now
    });
    yield s2.until('block', 1);
    yield s1.expectJSON('/blockchain/current', { number: 0 });
    yield s2.expectJSON('/blockchain/current', { number: 0 });
    yield s1.commit({
      time: now
    });
    yield s2.until('block', 1);
    yield s1.expectJSON('/blockchain/current', { number: 1 });
    yield s2.expectJSON('/blockchain/current', { number: 1 });
    s1.conf.cpu = 1.0;
    s2.conf.cpu = 0.02;
    yield Promise.all([

      // Make a concurrent trial
      Promise.all([
        co(function*() {
          try {
            let s2commit = s2.commit({ time: now + 10 });
            // A little handicap for s1 which will find the proof immediately
            setTimeout(() => s1.commit({ time: now + 10 }), 500);
            yield s2commit;
            throw 's2 server should not have found the proof before s1';
          } catch (e) {
            should.exist(e);
            e.should.equal('Proof-of-work computation canceled');
          }
        })
      ]),

      // We wait until both nodes received the new block
      s1.until('block', 1),
      s2.until('block', 1)
    ]);
    yield s1.expectJSON('/blockchain/current', { number: 2 });
    yield s2.expectJSON('/blockchain/current', { number: 2 });
    // Both nodes should receive the same last block from s2
    s2.conf.cpu = 1.0;
    yield [
      s1.until('block', 1),
      s2.until('block', 1),
      s2.commit({ time: now + 10 })
    ];
    yield s1.expectJSON('/blockchain/current', { number: 3 });
    yield s2.expectJSON('/blockchain/current', { number: 3 });
  }));
});
