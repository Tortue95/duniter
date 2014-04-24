var service       = require('../service');
var jpgp          = require('../lib/jpgp');
var async         = require('async');
var mongoose      = require('mongoose');
var _             = require('underscore');
var Amendment     = mongoose.model('Amendment');
var PublicKey     = mongoose.model('PublicKey');
var Merkle        = mongoose.model('Merkle');
var Coin          = mongoose.model('Coin');
var Key           = mongoose.model('Key');
var Transaction   = mongoose.model('Transaction');
var THTEntry      = mongoose.model('THTEntry');
var TxMemory      = mongoose.model('TxMemory');
var MerkleService = service.Merkle;
var logger        = require('../lib/logger')();

// Services
var PeeringService = service.Peering;

module.exports.get = function (pgp, currency, conf) {

  this.processTx = function (tx, doFilter, callback) {
    if (arguments.length == 2) {
      callback = doFilter;
      doFilter = true;
    }
    async.waterfall([
      function (next) {
        if (doFilter) {
          TxMemory.getTheOne(tx.sender, tx.number, tx.hash, function (err, found) {
            if(err) {
              // Sibling was not found: transaction was not processed
              var txMem = new TxMemory({
                "sender": tx.sender,
                "number": tx.number,
                "hash": tx.hash
              });
              txMem.save(function (err){
                next(err);
              });
            } else {
              tx = found;
              next('Transaction already processed', true);
            }
          });
        } else {
          next();
        }
      }
    ], function (err, alreadyProcessed) {
      if (!err && !alreadyProcessed) {
        err = tx.check();
      }
      if(err && alreadyProcessed){
        callback(err, tx, alreadyProcessed);
      }
      else if(err){
        callback(err);
      }
      else{
        transfert(tx, callback);
      }
    });
  }

  function transfert(tx, callback) {
    var senderManaged = false;
    var recipientManaged = false;
    async.waterfall([
      function (next) {
        async.parallel({
          sender: function(senderDone){
            async.waterfall([
              function (next){
                Key.isManaged(tx.sender, next);
              },
              function (isManaged, next){
                senderManaged = isManaged;
                if(!isManaged){
                  next('Sender\'s key ' + tx.sender + ' not managed by this node');
                  return;
                }
                // Get last transaction
                Transaction.findLastOf(tx.sender, function (err, lastTX) {
                  if(lastTX){
                    // Verify tx chaining
                    if(lastTX.number != tx.number - 1){
                      next('Transaction doest not follow your last one');
                      return;
                    }
                    if(lastTX.hash != tx.previousHash) {
                      next('Transaction have wrong previousHash (given ' + tx.previousHash + ', expected ' + lastTX.hash + ')');
                      return;
                    }
                  }
                  else{
                    if(tx.number != 0){
                      next('Transaction must have number #0 as it is your first');
                      return;
                    }
                    if(tx.previousHash){
                      next('Transaction must not have a previousHash as it is your first');
                      return;
                    }
                  }
                  next();
                });
              },
              function (next){
                // Verify coins can be spent
                async.forEach(tx.getCoins(), function(coin, callback){
                  async.waterfall([
                    function (next){
                      Coin.findByCoinID(coin.issuer, coin.amNumber, coin.coinNumber, next);
                    },
                    function (c, next){
                      if (c.owner != tx.sender) {
                        next('Sender does not own coin ' + coin.toString());
                        return;
                      }
                      next();
                    },
                  ], callback);
                }, next);
              }
            ], function (err) {
              // Do not send err as async.parallel() error, but as a result.
              // So async wait for recipient() to end too.
              senderDone(null, err);
            });
          },
          recipient: function(recipientDone){
            async.waterfall([
              function (next){
                Key.isManaged(tx.recipient, next);
              },
              function (isManaged, next){
                recipientManaged = isManaged;
                if(isManaged){
                  // Recipient managed: transaction will be saved
                  // without local full transaction chain test
                  next();
                }
                else{
                  next('Recipient\'s key ' + tx.recipient + ' is not managed by this node');
                }
              }
            ], function (err) {
              // Do not send err as async.parallel() error, but as a result.
              // So async wait for sender() to end too.
              recipientDone(null, err);
            });
          },
        },
        function(err, results) {
          var senderError = results.sender;
          var recipientError = results.recipient;
          if(senderError && senderManaged){
            next(senderError);
            return;
          }
          if(recipientError && recipientManaged){
            next(recipientError);
            return;
          }
          if(!senderManaged && !recipientManaged){
            next('Neither sender nor recipient managed by this node');
            return;
          }
          next(null, senderManaged, recipientManaged);
        });
      },
      function (senderManaged, recipientManaged, next) {
        // Change coins ownership
        // * case sender managed: always process TX changes
        // * case recipient managed: do only if network's state matches THT requirements --> for now, accept whatever happens
        if (senderManaged) {
          async.forEach(tx.getCoins(), function(coin, callback){
            async.waterfall([
              function (next){
                Coin.findByCoinID(coin.issuer, coin.amNumber, coin.coinNumber, next);
              },
              function (c, next){
                c.owner = tx.recipient;
                c.save(function (err) {
                  if (err)
                    logger.error(err);
                  next(err);
                });
              },
            ], callback);
          }, next);
        } else {
          async.forEach(tx.getCoins(), function(coin, callback){
            async.waterfall([
              function (next){
                THTEntry.getTheOne(tx.recipient, next);
              },
              function (thtentry, next){
                PeeringService.coinIsOwned(tx.sender, coin, thtentry, next);
              },
              function (owned, next){
                var err = !owned ? 'Coin ' + coin.toString() + ' does not appear to be owned be sender, according to network' : null;
                next(err);
              },
            ], callback);
          }, next);
        }
      },
      function (next){
        tx.save(next);
      },
      function (txSaved, code, next){
        Merkle.updateForTransfert(txSaved, next);
      }
    ], function (err, result) {
      callback(err, tx);
    });
  }

  return this;
}
