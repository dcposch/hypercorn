'use strict';

const async = require('async');
const assert = require('assert');
const debug = require('debug')('hypercorn');
const path = require('path');
const mkdirp = require('mkdirp');
const datDefaults = require('datland-swarm-defaults');
const HyperChain = require('hyperbloom-chain');
const HyperBloom = require('hyperbloom');
const Buffer = require('buffer').Buffer;
const Joi = require('joi');

const hypercorn = require('../hypercorn');
const schema = hypercorn.schema;
const utils = hypercorn.utils;
const Feed = hypercorn.Feed;

const FEED_DIR = 'hypercore';
const BLOOM_DIR = 'hyperbloom';
const TRUST_DIR = 'trust.db';

const DEFAULT_EXPIRATION = 3600 * 24 * 365;  // 1 year

const HYPERCORN_VERSION = 1;

function HyperCorn(options) {
  this.options = Object.assign({}, options);
  assert.equal(typeof this.options.storage, 'string',
               '`options.storage` must be a path to directory');

  this.feedDir = path.join(this.options.storage, FEED_DIR);
  const bloomDir = path.join(this.options.storage, BLOOM_DIR);

  mkdirp.sync(this.feedDir);
  mkdirp.sync(bloomDir);

  let pair = {
    publicKey: this.options.publicKey,
    privateKey: this.options.privateKey,
    justCreated: false
  };

  if (!pair.publicKey || !pair.privateKey)
    pair = utils.loadKey(this.options.storage);

  this.pair = pair;

  this.hyperbloom = new HyperBloom({
    storage: bloomDir,
    publicKey: this.pair.publicKey,
    privateKey: this.pair.privateKey,
    trust: {
      db: path.join(bloomDir, TRUST_DIR)
    },
    discovery: datDefaults()
  });

  this._chain = new HyperChain({ root: this.pair.publicKey });
  this._feeds = new Map();

  this._main = {
    feed: null,
    watcher: null
  };
}
module.exports = HyperCorn;

// Public

HyperCorn.prototype.listen = function listen(callback) {
  const feed = new Feed({
    hyperbloom: this.hyperbloom,
    feedDir: path.join(this.feedDir, this.pair.publicKey.toString('hex')),
    full: true,

    feedKey: this.pair.publicKey,
    privateKey: this.pair.privateKey
  });

  this._main.feed = feed;
  this._feeds.set(this.pair.publicKey.toString('base64'), feed);

  feed.once('ready', () => {
    feed.watch({
      start: 0
    }, (err, watcher) => {
      if (err)
        return debug('watch err=%s', err.message);

      watcher.message.on('data', msg => this._onSelfMessage(msg));

      this._main.watcher = watcher;

      callback(null);
    });
  });

  if (this.pair.justCreated) {
    feed.once('hypercore', () => {
      this._postOpen();
    });
  }
};

HyperCorn.prototype.close = function close(callback) {
  let waiting = 1;
  const done = () => {
    if (--waiting === 0 && callback)
      return callback();
  };
  this.hyperbloom.close(done);

  const main = this._main;
  this._main = null;
  if (main.feed && main.watcher) {
    main.feed.unwatch(main.watcher);
    waiting++;
    main.feed.close(done);
  }
};

HyperCorn.prototype.getFeedKey = function getFeedKey() {
  return this.pair.publicKey;
};

// Timeline

HyperCorn.prototype.getTimeline = function getTimeline(options, callback) {
  assert(Buffer.isBuffer(options.feedKey),
         '`options.feedKey` must be a Buffer');
  assert.equal(typeof options.offset, 'number',
               '`options.offset` must be a Number');
  assert.equal(typeof options.limit, 'number',
               '`options.limit` must be a Number');

  const base64Key = options.feedKey.toString('base64');
  debug('timeline request key=%s offset=%d limit=%d', base64Key,
        options.offset, options.limit);

  this._withFeed(options.feedKey, (feed, done) => {
    feed.getTimeline(options, (err, data) => {
      done();
      callback(err, data);
    });
  });
};

HyperCorn.prototype.getMessage = function getMessage(options, callback) {
  assert(Buffer.isBuffer(options.feedKey),
         '`options.feedKey` must be a Buffer');
  assert.equal(typeof options.index, 'number',
               '`options.index` must be a Number');

  const base64Key = options.feedKey.toString('base64');
  debug('message request key=%s index=%d', base64Key, options.index);

  this._withFeed(options.feedKey, (feed, done) => {
    feed.getMessage(options, (err, data) => {
      done();
      callback(err, data);
    });
  });
};

// Messages

HyperCorn.prototype.trust = function trust(feedKey, options, callback) {
  const base64PublicKey = feedKey.toString('base64');
  debug('trust key=%s', base64PublicKey);

  options = Object.assign({
    expiresIn: DEFAULT_EXPIRATION
  }, options);

  const expiresAt = Date.now() / 1000 + options.expiresIn;

  const link = this._chain.issueLink({
    publicKey: feedKey,
    expiration: expiresAt
  }, this.pair.privateKey);

  this._main.feed.append('trust', {
    expires_at: expiresAt,
    feed_key: base64PublicKey,
    link: link.toString('base64'),
    description: options.description
  }, callback);

  return link;
};

HyperCorn.prototype.follow = function follow(feedKey, callback) {
  const base64FeedKey = feedKey.toString('base64');
  debug('follow feed=%s', base64FeedKey);
  this._main.feed.append('follow', {
    feed_key: base64FeedKey
  }, callback);
};

HyperCorn.prototype.unfollow = function unfollow(feedKey, callback) {
  const base64FeedKey = feedKey.toString('base64');
  debug('unfollow feed=%s', base64FeedKey);
  this._main.feed.append('unfollow', {
    feed_key: base64FeedKey
  }, callback);
};

HyperCorn.prototype.post = function post(object, callback) {
  debug('new post');
  this._main.feed.append('post', {
    content: object.content,
    reply_to: object.replyTo && {
      feed_key: object.replyTo.feedKey.toString('base64'),
      index: object.replyTo.index
    }
  }, (err, index) => {
    if (err) {
      debug('post append error=%s', err.message);
      if (callback)
        callback(err);
      return;
    }

    if (object.replyTo)
      this._addReply(index, object.replyTo, callback);
    else if (callback)
      callback(null);
  });
};

// Private

HyperCorn.prototype._postOpen = function _postOpen() {
  debug('posting open');
  this._main.feed.append('open', {
    protocol: 'hypercorn',
    version: HYPERCORN_VERSION
  });
};

HyperCorn.prototype._withFeed = function _withFeed(feedKey, body) {
  const base64Key = feedKey.toString('base64');
  if (this._feeds.has(base64Key)) {
    process.nextTick(body, this._feeds.get(base64Key), () => {});
    return;
  }

  // No existing feeds, try to get sparse feed
  const feed = new Feed({
    hyperbloom: this.hyperbloom,
    feedDir: path.join(this.feedDir, feedKey.toString('hex')),
    full: false,

    feedKey
  });

  feed.on('trust', (trust) => {
    this._onExternalTrust(trust.payload, feedKey);
  });

  feed.once('ready', () => {
    body(feed, () => {
      feed.close(() => {});
    });
  });
};

HyperCorn.prototype._addReply = function _addReply(index, options, callback) {
  debug('adding reply');

  this._withFeed(options.feedKey, (feed, done) => {
    feed.addReply(options.index, {
      feedKey: this.getFeedKey(),
      index
    }, () => {
      if (callback)
        callback(null);
      done();
    });
  });
};

HyperCorn.prototype._onSelfMessage = function _onSelfMessage(message) {
  if (message.type === 'follow')
    this._onFollow(message.payload);
  else if (message.type === 'unfollow')
    this._onUnfollow(message.payload);
  else if (message.type === 'trust')
    this._onTrust(message.payload);
  else if (message.type === 'open')
    debug('has open');
};

HyperCorn.prototype._onFollow = function _onFollow(payload) {
  const { error, value } = Joi.validate(payload, schema.Follow);
  if (error)
    return debug('validation err=%s', error.message);

  if (this._feeds.has(value.feed_key))
    return;

  debug('on follow feed=%s', value.feed_key);

  const feedKey = Buffer.from(value.feed_key, 'base64');

  const feed = new Feed({
    hyperbloom: this.hyperbloom,
    feedDir: path.join(this.feedDir, feedKey.toString('hex')),
    full: true,

    feedKey: feedKey
  });

  feed.watch({
    start: 0
  }, (err, watcher) => {
    if (err)
      return debug('watch err=%s', err.message);

    watcher.message.on('data', msg => this._onExternalMessage(msg, feedKey));

    this._feeds.set(value.feed_key, feed);
  });
};

HyperCorn.prototype._onUnfollow = function _onUnfollow(payload) {
  const { error, value } = Joi.validate(payload, schema.Unfollow);
  if (error)
    return debug('validation err=%s', error.message);

  if (!this._feeds.has(value.feed_key))
    return;

  debug('on unfollow feed=%s', value.feed_key);

  const feed = this._feeds.get(payload_feed_key);
  feed.close(() => {});
};

HyperCorn.prototype._onTrust = function _onTrust(payload) {
  const { error, value } = Joi.validate(payload, schema.TrustMessage);
  if (error)
    return debug('validation err=%s', error.message);

  debug('on trust key=%s', value.feed_key);

  const link = Buffer.from(value.link, 'base64');
  this.hyperbloom.addLink(this.getFeedKey(), link);
};

HyperCorn.prototype._onExternalMessage = function _onExternalMessage(message,
                                                                     feedKey) {
  if (message.type === 'trust')
    this._onExternalTrust(message.payload, feedKey);
};

HyperCorn.prototype._onExternalTrust = function _onExternalTrust(payload,
                                                                 feedKey) {
  const { error, value } = Joi.validate(payload, schema.TrustMessage);
  if (error)
    return debug('validation err=%s', error.message);

  const link = Buffer.from(value.link, 'base64');
  debug('on external trust key=%s by=%s', value.feed_key,
        feedKey.toString('base64'));

  // TODO(indutny): refresh feeds to load hyperbloom nodes
  this.hyperbloom.addLink(feedKey, link);
};
