'use strict';

const util      = require('util');
const slack     = require('@slack/client');
const AwaitLock = require('await-lock');
const ircd      = require('./ircd');
const slackInit = require('./slack-init');
const debugChannel = '+irslackd';

class Irslackd {
  constructor(config) {
    this.config = config;
    this.socket = null;
    this.ircd = null;
    this.rtmMap = new Map();
    this.socketMap = new Map();
  }
  listen() {
    const self = this;
    self.ircd = self.getNewIrcd(self.config.tlsOpts);
    const requireInit = true;
    const noRequireInit = false;
    new Map([
      [ 'AWAY',     self.makeIrcHandler(self.onIrcAway,    requireInit)   ],
      [ 'INVITE',   self.makeIrcHandler(self.onIrcInvite,  requireInit)   ],
      [ 'JOIN',     self.makeIrcHandler(self.onIrcJoin,    requireInit)   ],
      [ 'KICK',     self.makeIrcHandler(self.onIrcKick,    requireInit)   ],
      [ 'LIST',     self.makeIrcHandler(self.onIrcList,    requireInit)   ],
      [ 'MODE',     self.makeIrcHandler(self.onIrcMode,    noRequireInit) ],
      [ 'NICK',     self.makeIrcHandler(self.onIrcNick,    noRequireInit) ],
      [ 'PART',     self.makeIrcHandler(self.onIrcPart,    requireInit)   ],
      [ 'PASS',     self.makeIrcHandler(self.onIrcPass,    noRequireInit) ],
      [ 'PING',     self.makeIrcHandler(self.onIrcPing,    noRequireInit) ],
      [ 'PRIVMSG',  self.makeIrcHandler(self.onIrcPrivmsg, requireInit)   ],
      [ 'QUIT',     self.makeIrcHandler(self.onIrcQuit,    requireInit)   ],
      [ 'TOPIC',    self.makeIrcHandler(self.onIrcTopic,   requireInit)   ],
      [ 'USER',     self.makeIrcHandler(self.onIrcUser,    noRequireInit) ],
      [ 'WHOIS',    self.makeIrcHandler(self.onIrcWhois,   requireInit)   ],
      [ 'WHO',      self.makeIrcHandler(self.onIrcWho,     requireInit)   ],
      [ 'ircLine',  self.makeIrcHandler(self.onIrcLine,    noRequireInit) ],
      [ 'ircError', self.makeIrcHandler(self.onIrcError,   noRequireInit) ],
      [ 'ircClose', self.makeIrcHandler(self.onIrcClose,   noRequireInit) ],
      [ 'ircConnect', (socket) => { self.onIrcConnect(socket); } ],
    ]).forEach((handler, cmd, map) => {
      self.ircd.on(cmd, handler);
    });
    self.ircd.listen(self.config.port, self.config.host);
  }
  async onIrcConnect(socket) {
    this.socketMap.set(socket, new IrcUser(socket));
  }
  async onIrcClose(ircUser, hadError) {
    console.log('irc_out', 'Disconnecting client');
    try {
      if (ircUser.socket) {
        ircUser.socket.destroy();
        this.socketMap.delete(ircUser.socket);
      }
      if (ircUser.slackRtm) {
        ircUser.slackRtm.disconnect();
        this.rtmMap.delete(ircUser.slackRtm);
      }
      if (ircUser.slackWeb) {
        await this.setSlackPresence(ircUser, false);
      }
    } catch (e) {
      this.logError(ircUser, 'Caught exception at disconnect: ' + util.inspect(e));
    }
  }
  async onIrcPass(ircUser, msg) {
    let allArgs = msg.args.join(' ').split(' ');
    ircUser.slackToken = allArgs.shift();
    ircUser.preferences = allArgs;
  }
  async onIrcNick(ircUser, msg) {
    ircUser.ircNick = msg.args[0] || 'user';
  }
  async onIrcUser(ircUser, msg) {
    const self = this;
    ircUser.slackWeb = self.getNewSlackWebClient(ircUser.slackToken);
    ircUser.slackWeb.paginateCallOrThrow = self.paginateCallOrThrow;
    ircUser.slackWeb.apiCallOrThrow = self.apiCallOrThrow;
    ircUser.slackRtm = self.getNewSlackRtmClient(ircUser.slackToken);

    // Identify end-user
    let auth = await ircUser.slackWeb.apiCallOrThrow('auth.test');
    ircUser.slackUserId = auth.user_id;

    // Set nick
    let origNick = ircUser.ircNick;
    ircUser.ircNick = (await this.resolveSlackUser(ircUser, ircUser.slackUserId)) || ircUser.ircNick;
    if (origNick !== ircUser.ircNick) {
      this.ircd.write(ircUser.socket, origNick, 'NICK', [ ircUser.ircNick ]);
    }

    // Setup Slack handlers
    self.rtmMap.set(ircUser.slackRtm, ircUser);
    new Map([
      [ 'ready',                 self.makeSlackHandler(self.onSlackReady)               ],
      [ 'message',               self.makeSlackHandler(self.onSlackMessage)             ],
      [ 'channel_joined',        self.makeSlackHandler(self.onSlackChannelJoined)       ],
      [ 'channel_left',          self.makeSlackHandler(self.onSlackChannelLeft)         ],
      [ 'channel_rename',        self.makeSlackHandler(self.onSlackChannelRename)       ],
      [ 'channel_created',       self.makeSlackHandler(self.onSlackChannelCreated)      ],
      [ 'member_joined_channel', self.makeSlackHandler(self.onSlackMemberJoinedChannel) ],
      [ 'member_left_channel',   self.makeSlackHandler(self.onSlackMemberLeftChannel)   ],
      [ 'mpim_open',             self.makeSlackHandler(self.onSlackMpimOpen)            ],
      [ 'mpim_close',            self.makeSlackHandler(self.onSlackMpimClose)           ],
      [ 'reaction_added',        self.makeSlackHandler(self.onSlackReactionAdded)       ],
      [ 'reaction_removed',      self.makeSlackHandler(self.onSlackReactionRemoved)     ],
      [ 'subteam_created',       self.makeSlackHandler(self.onSlackSubteamUpdated)      ],
      [ 'subteam_updated',       self.makeSlackHandler(self.onSlackSubteamUpdated)      ],
      [ 'user_typing',           self.makeSlackHandler(self.onSlackUserTyping)          ],
      [ 'presence_change',       self.makeSlackHandler(self.onSlackPresenceChange)      ],
      [ 'team_join',             self.makeSlackHandler(self.onSlackTeamJoin)            ],
      [ 'slack_event',           self.makeSlackHandler(self.onSlackEvent)               ],
    ]).forEach((handler, event, map) => {
      ircUser.slackRtm.on(event, handler);
    });

    // Wait for initialization
    await self.initialize(ircUser);

    // Start RTM
    ircUser.slackRtm.start({
      batch_presence_aware: ircUser.presenceEnabled(),
    });
    self.updatePresenceSubscriptions(ircUser);
  }
  async onIrcAway(ircUser, msg) {
    // if args is empty, unset away status
    let status;
    if (msg.args.length === 0) {
      status = '';
      this.setSlackPresence(ircUser, true);
    } else {
      status = msg.args[0];
      // slack statuses are capped at 100 characters
      status = status.substring(0, 100);
      this.setSlackPresence(ircUser, false);
    }
    await ircUser.slackWeb.apiCallOrThrow('users.profile.set', {
      profile: {
        status_text: status,
        status_emoji: '',
      },
    });
  }
  async onIrcJoin(ircUser, msg) {
    const self = this;
    let ircChans = msg.args[0].split(',');
    let joinPromises = [];
    for (let ircChan of ircChans) {
      if (!ircUser.isInChannel(ircChan)) {
        joinPromises.push(self.onIrcJoinOne(ircUser, ircChan, false));
      }
    }
    await Promise.all(joinPromises);
  }
  async onIrcJoinOne(ircUser, ircChan, alreadyInSlackChanId) {
    const self = this;
    // Warn if IRC client is trying to join an `#mpdm*` channel
    // Probably an automated rejoin...
    if (!alreadyInSlackChanId && ircChan.substr(0, 5) === '#mpdm') {
      console.log('Refusing IRC mpdm join: ' + ircChan);
      return;
    }

    // Handle special irslackd channel
    if (ircChan === debugChannel) {
      this.onIrcDebugJoin(ircUser);
      return;
    }

    // Join Slack channel
    let convo;
    let alreadyInSlackChan;
    let slackChanId;
    if (!alreadyInSlackChanId) {
      let slackChanName = ircChan;
      if (slackChanName.substr(0, 1) === '#') slackChanName = slackChanName.substr(1);
      convo = await ircUser.slackWeb.apiCallOrThrow('channels.join', { name: slackChanName });
      alreadyInSlackChan = convo.already_in_channel;
      slackChanId = convo.channel.id;
    } else {
      alreadyInSlackChan = true;
      slackChanId = alreadyInSlackChanId;
    }

    // Bail if already in channel on Slack and IRC
    if (alreadyInSlackChan && ircUser.isInChannel(ircChan)) {
      return;
    }

    if (alreadyInSlackChan) {
      // Call conversations.info
      // (channels.join returns limited channel info if already in channel case)
      convo = await ircUser.slackWeb.apiCallOrThrow('conversations.info', { channel: slackChanId });
    }

    // Update maps
    ircUser.mapIrcToSlack(ircChan, convo.channel.id);

    // Get Slack channel members
    let members = await ircUser.slackWeb.paginateCallOrThrow('conversations.members', 'members', {
      channel: convo.channel.id,
      limit: 1000,
    });

    // Assemble IRC nicks
    let ircNicks = [ ircUser.ircNick ];
    let ircNickPromises = [];
    members.members.forEach((userId) => {
      let ircNickPromise = self.resolveSlackUser(ircUser, userId);
      ircNickPromise.userId = userId;
      ircNickPromises.push(ircNickPromise);
    });
    for (let ircNickPromise of ircNickPromises) {
      try {
        ircNicks.push(await ircNickPromise);
      } catch (e) {
        this.logError(ircUser, 'No user for userId ' + ircNickPromise.userId);
      }
    }

    // Join channel
    this.sendIrcChannelJoin(ircUser, ircChan, convo.channel.topic.value, ircNicks);
  }
  async onIrcPart(ircUser, msg, alreadyInSlackChanId) {
    let ircChan = msg.args[0];

    // Handle special irslackd channel
    if (ircChan === debugChannel) {
      this.onIrcDebugPart(ircUser);
      return;
    }

    let slackChan;
    if (!alreadyInSlackChanId) {
      // Bail if Slack channel not in map
      slackChan = ircUser.ircToSlack.get(ircChan);
      if (!slackChan) {
        this.logError(ircUser, 'No entry in ircToSlack for channel ' + ircChan);
        return;
      }
    } else {
      slackChan = alreadyInSlackChanId;
    }

    // Leave Slack channel
    let apiMethod = slackChan.substr(0, 1) === 'G' ? 'mpim.close' : 'conversations.leave';
    await ircUser.slackWeb.apiCallOrThrow(apiMethod, { channel: slackChan });

    // Unset channel marker and leave IRC channel
    this.sendIrcChannelPart(ircUser, ircChan);
  }
  async onIrcPrivmsg(ircUser, msg) {
    let target = msg.args[0];
    let message = msg.args[1];

    // Handle debug commands
    if (target === debugChannel) {
      msg.args.shift();
      return this.onIrcDebugPrivmsg(ircUser, msg);
    }

    // Handle @slack commands
    if (message.substr(0, 7) === '@slack ') {
      msg.args[1] = msg.args[1].substr(7);
      return await this.onIrcAtSlackPrivmsg(ircUser, msg);
    }

    // Extract @thread-<thread_ts> prefix
    let thread_ts;
    [message, thread_ts] = this.extractThread(message);

    // Slackize
    message = this.slackizeText(ircUser, message);

    // Resolve target as Slack channel
    let slackChan;
    let slackTarget = ircUser.ircToSlack.get(target);
    if (!slackTarget) throw Error('No entry in ircToSlack for target ' + target);
    if (target.substr(0, 1) === '#') {
      // Sending to a channel, update map
      slackChan = slackTarget;
      ircUser.mapIrcToSlack(target, slackChan);
    } else {
      // Sending to a user, update nick-channel map
      slackChan = ircUser.ircNickToSlackChanId.get(target);
      if (!slackChan) {
        let im = await ircUser.slackWeb.apiCallOrThrow('im.open', { user: slackTarget });
        slackChan = im.channel.id;
        ircUser.ircNickToSlackChanId.set(target, slackChan);
      }
    }

    // Check for /me message
    let apiMethod = 'chat.postMessage';
    if (this.isCtcpCommand('ACTION', message)) {
      apiMethod = 'chat.meMessage';
      message = message.substr(8);
      if (message.charCodeAt(message.length - 1) === 1) {
        message = message.substr(0, message.length - 1);
      }
    }

    // Check for CTCP TYPING message
    if (ircUser.typingNotificationsEnabled() && this.isCtcpCommand('TYPING', message)) {
      return await ircUser.slackRtm.sendTyping(slackChan);
    }

    // Call chat.(post|me)Message
    await this.rememberSelfEcho(ircUser, message, async() => {
      return await ircUser.slackWeb.apiCallOrThrow(apiMethod, {
        channel: slackChan,
        text: message,
        as_user: true,
        thread_ts: thread_ts,
      });
    });
  }
  async onIrcPing(ircUser, msg) {
    // Send PONG
    this.ircd.write(ircUser.socket, 'irslackd', 'PONG', [ 'irslackd' ]);
  }
  async onIrcMode(ircUser, msg) {
    let target = msg.args[0];
    if (target.substr(0, 1) === '#') {
      this.ircd.write(ircUser.socket, 'irslackd', 'MODE', msg.args);
    }
  }
  async onIrcInvite(ircUser, msg) {
    const ircChan = msg.args[1];
    const ircNick = msg.args[0];
    const slackUser = ircUser.ircToSlack.get(ircNick);
    const slackChan = ircUser.ircToSlack.get(ircChan);
    if (!slackUser || !slackChan) {
      this.logError(ircUser, 'Cannot determine target for INVITE; saw ' + util.inspect(msg.args));
      return;
    }

    await ircUser.slackWeb.apiCallOrThrow('conversations.invite', {
      users: slackUser,
      channel: slackChan,
    });

    this.ircd.write(ircUser.socket, 'irslackd', '341', [
      ircUser.ircNick,
      ircNick,
      ircChan,
    ]);
  }
  async onIrcTopic(ircUser, msg) {
    const ircChan = msg.args[0];
    let ircTopic = msg.args[1];
    const slackChan = ircUser.ircToSlack.get(ircChan);
    if (!slackChan) {
      this.logError(ircUser, 'Cannot determine target for INVITE; saw ' + util.inspect(msg.args));
      return;
    }

    let res;
    if (ircTopic) {
      // Set topic
      res = await ircUser.slackWeb.apiCallOrThrow('conversations.setTopic', {
        channel: slackChan,
        topic: ircTopic,
      });
      ircTopic = res.topic;
    } else {
      // Get topic
      res = await ircUser.slackWeb.apiCallOrThrow('conversations.info', {
        channel: slackChan,
      });
    }
    ircTopic = this.ircizeText(ircUser, res.channel.topic.value);

    this.ircd.write(ircUser.socket, 'irslackd', '332', [
      ircUser.ircNick,
      ircChan,
      ':' + ircTopic,
    ]);
  }
  async onIrcKick(ircUser, msg) {
    const ircChan = msg.args[0];
    const ircNick = msg.args[1];

    const slackUser = ircUser.ircToSlack.get(ircNick);
    const slackChan = ircUser.ircToSlack.get(ircChan);
    if (!slackUser || !slackChan) {
      this.logError(ircUser, 'Cannot determine target for KICK; saw ' + util.inspect(msg.args));
      return;
    }

    await ircUser.slackWeb.apiCallOrThrow('conversations.kick', {
      channel: slackChan,
      user: slackUser,
    });

    this.ircd.write(ircUser.socket, ircUser.ircNick, 'KICK', msg.args);
  }
  async onIrcList(ircUser, msg) {
    const self = this;
    if (msg.args.length > 0) return; // Only support `LIST` with no params
    let convos = await ircUser.slackWeb.paginateCallOrThrow('conversations.list', 'channels', {
      exclude_archived: true,
      types: 'public_channel',
      limit: 1000,
    });
    convos.channels.forEach((channel) => {
      self.ircd.write(ircUser.socket, 'irslackd', '322', [
        ircUser.ircNick,
        '#' + channel.name,
        channel.num_members,
        ':' + channel.topic.value,
      ]);
    });
    self.ircd.write(ircUser.socket, 'irslackd', '323', [ ircUser.ircNick, ':End of LIST' ]);
  }
  async onIrcQuit(ircUser, msg) {
    // Close link
    this.ircd.write(ircUser.socket, 'irslackd', 'ERROR', [ ':Closing Link' ]);
    ircUser.socket.destroy();
  }
  async initialize(ircUser) {
    // Initialize Slack users and channels in an efficient, batch way
    // Await on usernames and teams as they are needed before populating channels
    try {
      await slackInit.initUsers.call(this, ircUser);
      await slackInit.initTeams.call(this, ircUser);
      await slackInit.initChannels.call(this, ircUser);
      if (ircUser.debugChannelEnabled()) this.onIrcDebugJoin(ircUser);
    } catch (e) {
      this.logError(ircUser, 'Failed to initialize workspace:' + util.inspect(e));
    } finally {
      ircUser.setInitialized();
      console.log('slack_out: initialized');
    }
  }
  async onSlackReady(ircUser, event) {
    // Send MOTD
    this.ircd.write(ircUser.socket, 'irslackd', '001', [ ircUser.ircNick, 'irslackd' ]);
    this.ircd.write(ircUser.socket, 'irslackd', '376', [ ircUser.ircNick, 'End of MOTD' ]);

    // set user presence to auto instead of away
    await this.setSlackPresence(ircUser, true);
  }
  async onSlackMessage(ircUser, event) {
    const self = this;

    // Delegate certain events
    if (event.subtype === 'channel_join') {
      return await this.onSlackMemberJoinedChannel(ircUser, event);
    } else if (event.subtype === 'channel_leave') {
      return await this.onSlackMemberLeftChannel(ircUser, event);
    } else if (event.subtype === 'channel_topic' || event.subtype === 'group_topic') {
      return await this.onSlackTopicChange(ircUser, event);
    } else if (event.subtype === 'message_replied' && !event.text) {
      return;
    }

    // If this is a message in a thread and they are not enabled, bail
    if (event.thread_ts && !ircUser.threadsEnabled()) {
      return;
    }

    // Fix user field in file_comment
    if (event.subtype === 'file_comment') {
      event.user = event.comment.user;
    }

    // Make certain messages appear as `/me` actions
    if (event.subtype === 'message_changed') {
      if (event.message.text === event.previous_message.text) {
        return; // Ignore message_changed events if text did not change
      }
      event.user = event.message.user;
      event.text = 'edits: ' + event.message.text;
      event.subtype = 'me_message';
    } else if (event.subtype === 'message_deleted') {
      event.user = event.previous_message.user;
      event.text = 'deletes: ' + event.previous_message.text;
      event.subtype = 'me_message';
    }

    // Decode and ircize text
    event.text = this.ircizeText(ircUser, event.text || '');

    // Prevent self-echo
    if (await this.preventSelfEcho(ircUser, event, event.text)) return;

    // Get nick and channel
    let [ircNick, ircTarget] = await this.resolveSlackTarget(ircUser, event);
    if (!ircNick || !ircTarget) {
      this.logError(ircUser, 'Failed this.resolveSlackTarget; event: ' + util.inspect(event));
      return;
    }

    // If not already in channel, join it
    if (ircTarget.substr(0, 1) === '#' && !ircUser.isInChannel(ircTarget)) {
      await this.onIrcJoinOne(ircUser, ircTarget, event.channel);
    }

    // Also send attachments
    let messages = [ event.text ];
    if (event.attachments) {
      event.attachments.forEach((attachment, idx) => {
        let att = new Set(); // Use a Set to avoid duplicates
        if (attachment.title)       att.add(self.ircizeText(ircUser, attachment.title));
        if (attachment.text)        att.add(self.ircizeText(ircUser, attachment.text));
        if (attachment.title_link)  att.add(attachment.title_link);
        if (attachment.fallback)    att.add(self.ircizeText(ircUser, attachment.fallback));
        if (attachment.from_url)    att.add(attachment.from_url);
        if (attachment.image_url)   att.add(attachment.image_url);
        att.forEach((a) => { messages.push('> ' + a); });
      });
    }

    // Also send files
    if (event.files) {
      event.files.forEach((file, idx) => {
        if (file.url_private) messages.push('> ' + file.url_private);
      });
    }

    // Send to IRC, once for each newline
    let sentCount = 0;
    messages.forEach((message, idx) => {
      message.split(/(\r\n|\r|\n)/).forEach((line, idx) => {
        line = line.trim();
        if (line.length < 1) return;
        if (event.thread_ts) line = '@thread-' + event.thread_ts + ' ' + line;
        if (event.subtype === 'me_message') line = self.meText(line);
        self.ircd.write(ircUser.socket, ircNick, 'PRIVMSG', [ ircTarget, ':' + line ]);
        sentCount += 1;
      });
    });

    // Warn if no PRIVMSG was sent
    if (sentCount < 1) {
      this.logError(ircUser, 'Incoming slack message produced no PRIVMSG: ' + util.inspect(event));
    }
  }
  async onSlackTopicChange(ircUser, event) {
    // Get nick and channel
    let [ircNick, ircChan] = await this.resolveSlackTarget(ircUser, event);
    if (!ircNick || !ircChan) return;

    // Decode entities, ircize text
    event.topic = this.ircizeText(ircUser, event.topic);

    // Send topic message
    this.ircd.write(ircUser.socket, ircNick, 'TOPIC', [ ircChan, event.topic ]);
  }
  async onSlackChannelJoined(ircUser, event) {
    let chanId = event.channel.id || event.channel;
    let ircChan = await this.resolveSlackChannel(ircUser, chanId);
    if (ircChan) {
      await this.onIrcJoinOne(ircUser, ircChan, chanId);
    }
  }
  async onSlackChannelLeft(ircUser, event) {
    let ircChan = await this.resolveSlackChannel(ircUser, event.channel);
    if (ircChan) {
      await this.onIrcPart(ircUser, { args: [ ircChan ] }, event.channel);
    }
  }
  async onSlackChannelRename(ircUser, event) {
    let oldIrcChan = await this.resolveSlackChannel(ircUser, event.channel.id);
    let newIrcChan = '#' + event.channel.name;
    let isInChan = ircUser.isInChannel(oldIrcChan);
    if (isInChan) {
      this.ircd.write(ircUser.socket, ircUser.ircNick, 'PART', [ oldIrcChan ]);
      ircUser.partChannel(oldIrcChan);
    }
    ircUser.ircToSlack.delete(oldIrcChan);
    ircUser.slackToIrc.delete(event.channel.id);
    if (isInChan) await this.onIrcJoinOne(ircUser, newIrcChan, event.channel.id);
  }
  async onSlackChannelCreated(ircUser, event) {
    ircUser.mapIrcToSlack('#' + event.channel.name, event.channel.id);
  }
  async onSlackMemberJoinedChannel(ircUser, event) {
    if (event.user === ircUser.slackUserId) return;
    let [ircNick, ircChan] = await this.resolveSlackTarget(ircUser, event);
    if (ircNick && ircChan && !ircUser.isNickInChannel(ircChan, ircNick)) {
      ircUser.addNickToChannel(ircChan, ircNick);
      this.ircd.write(ircUser.socket, ircNick, 'JOIN', [ ircChan ]);
    }
  }
  async onSlackMemberLeftChannel(ircUser, event) {
    if (event.user === ircUser.slackUserId) return;
    let [ircNick, ircChan] = await this.resolveSlackTarget(ircUser, event);
    if (ircNick && ircChan && ircUser.isNickInChannel(ircChan, ircNick)) {
      ircUser.removeNickFromChannel(ircChan, ircNick);
      this.ircd.write(ircUser.socket, ircNick, 'PART', [ ircChan ]);
    }
  }
  async onSlackMpimOpen(ircUser, event) {
    await this.onSlackChannelJoined(ircUser, event);
  }
  async onSlackMpimClose(ircUser, event) {
    await this.onSlackChannelLeft(ircUser, event);
  }
  async onSlackSubteamUpdated(ircUser, event) {
    ircUser.mapIrcToSlack(event.subteam.handle, event.subteam.id);
  }
  async onSlackReactionAdded(ircUser, event) {
    await this.onSlackReaction(ircUser, event, 'reacts');
  }
  async onSlackReactionRemoved(ircUser, event) {
    await this.onSlackReaction(ircUser, event, 'unreacts');
  }
  async onSlackReaction(ircUser, event, verb) {
    if (!ircUser.reactionsEnabled()) return;
    if (event.item.type !== 'message') return;
    if (!event.item_user) {
      let history = await ircUser.slackWeb.apiCallOrThrow('conversations.history', {
        channel: event.item.channel,
        latest: event.item.ts,
        count: 1,
        inclusive: 1,
      });
      if (history.messages.length > 0
        && history.messages[0].ts === event.item.ts
        && (history.messages[0].user || history.messages[0].bot_id)
      ) {
        event.item_user = history.messages[0].user || history.messages[0].bot_id;
      } else {
        this.logError(ircUser, 'No message found for event.item.ts; history=' + util.inspect(history));
        return;
      }
    }
    let ircReacter = this.resolveSlackUser(ircUser, event.user);
    let ircReactee = this.resolveSlackUser(ircUser, event.item_user);
    let ircChan    = this.resolveSlackChannel(ircUser, event.item.channel);
    try {
      ircReacter = await ircReacter;
      ircReactee = await ircReactee;
      ircChan    = await ircChan;
      if (!ircReacter || !ircReactee || !ircChan) {
        throw Error('Missing reaction info');
      }
    } catch (e) {
      this.logError(ircUser, util.inspect(e));
      return;
    }
    let message = this.meText(verb + ' @ ' + ircReactee + ' :' + event.reaction + ':');
    this.ircd.write(ircUser.socket, ircReacter, 'PRIVMSG', [ ircChan, message ]);
  }
  async onSlackUserTyping(ircUser, event) {
    if (!ircUser.typingNotificationsEnabled()) {
      return;
    }
    let [ircNick, ircTarget] = await this.resolveSlackTarget(ircUser, event);
    if (!ircNick || !ircTarget) {
      this.logError(ircUser, 'Failed this.resolveSlackTarget; event: ' + util.inspect(event));
      return;
    }
    console.log('slack_typing', ircNick, ircTarget);
    let line = this.typingText('1');
    this.ircd.write(ircUser.socket, ircNick, 'PRIVMSG', [ ircTarget, line ]);
  }
  async onSlackPresenceChange(ircUser, event) {
    if (!ircUser.presenceEnabled()) {
      return;
    }
    let ircNick = await this.resolveSlackUser(ircUser, event.user);
    let ircMode = null;
    if (event.presence === 'away') {
      ircUser.ircNickActive.delete(ircNick);
      ircMode = '-v';
    } else {
      ircUser.ircNickActive.add(ircNick);
      ircMode = '+v';
    }
    console.log('slack_presence_change', ircNick, event.presence);
    ircUser.channelNicks.forEach((nicks, channel) => {
      if (nicks.get(ircNick) && ircUser.isInChannel(channel)) {
        this.ircd.write(ircUser.socket, 'irslackd', 'MODE', [channel, ircMode, ircNick]);
      }
    });
  }
  async onSlackTeamJoin(ircUser, event) {
    // Add new member
    let slackUser = event.user.id;
    let ircNick = this.replaceIllegalIrcNickChars(event.user.name);
    ircUser.mapIrcToSlack(ircNick, slackUser);

    // Update presence subscriptions
    this.updatePresenceSubscriptions(ircUser);
  }
  async onIrcWho(ircUser, msg) {
    await this.onIrcWhois(ircUser, msg);
  }
  async onIrcWhois(ircUser, msg) {
    if (msg.args.length < 1) return;
    let ircNick = msg.args[0];
    if (ircNick.substr(0, 1) === '#') {
      return; // Ignore channels
    }
    let slackUser = ircUser.ircToSlack.get(ircNick);
    if (!slackUser) return;
    try {
      let user = await ircUser.slackWeb.apiCallOrThrow('users.info', { user: slackUser });
      this.ircd.write(ircUser.socket, 'irslackd', '311', [
        ircUser.ircNick,
        ircNick,
        ircNick,
        'irslackd',
        '*',
        ':' + (user.user.real_name || user.user.profile.display_name || user.user.name),
      ]);
    } catch (e) {
      this.ircd.write(ircUser.socket, 'irslackd', '401', [
        ircUser.ircNick,
        ircNick,
        ':No such nick/channel',
      ]);
    }
  }
  async onIrcAtSlackPrivmsg(ircUser, msg) {
    const self = this;
    const ircTarget = msg.args.shift();
    const cmdStr = msg.args.join(' ').trim();
    const [cmdArgs, cmdArgv] = this.parseAtSlackCmd(cmdStr);
    const atSlackCmd = cmdArgv.shift();

    const slackTarget = ircUser.ircToSlack.get(ircTarget);
    if (!slackTarget) throw Error('No entry in ircToSlack for target ' + ircTarget);

    let slackCmdFunc = null;
    switch (atSlackCmd) {
      case 'history':
        slackCmdFunc = this.onIrcAtSlackHistory;
        break;
      case 'search':
        slackCmdFunc = this.onIrcAtSlackSearch;
        break;
      case 'thread':
        slackCmdFunc = this.onIrcAtSlackThread;
        break;
      case 'react':
        slackCmdFunc = this.onIrcAtSlackReact;
        break;
      case 'unreact':
        slackCmdFunc = this.onIrcAtSlackUnreact;
        break;
      default:
    }
    const messages = await slackCmdFunc.call(this, ircUser, ircTarget, slackTarget, cmdArgs, cmdArgv);
    messages.forEach((message, idx) => {
      message.split(/(\r\n|\r|\n)/).forEach((line, idx) => {
        line = line.trim();
        if (line.length < 1) return;
        self.ircd.write(ircUser.socket, 'irslackd', 'NOTICE', [ ircTarget, ':' + line ]);
      });
    });
  }
  async onIrcAtSlackHistory(ircUser, ircTarget, slackTarget, cmdArgs, cmdArgv) {
    const history = await ircUser.slackWeb.apiCallOrThrow('conversations.history', {
      channel: slackTarget,
      limit: cmdArgs['limit'] || cmdArgs['l'] || 20,
    });
    return history.messages.map(h => JSON.stringify(h)).reverse();
  }
  async onIrcAtSlackSearch(ircUser, ircTarget, slackTarget, cmdArgs, cmdArgv) {
    const results = await ircUser.slackWeb.apiCallOrThrow('search.messages', {
      query: cmdArgv.join(' '),
      count: cmdArgs['limit'] || cmdArgs['l'] || 20,
    });
    return results.messages.matches.map((m) => {
      const ircChan = ircUser.slackToIrc.get(m.channel.id) || m.channel.id;
      const ircNick = ircUser.slackToIrc.get(m.user)       || m.user;
      return ircChan + ' @' + m.ts + ' <' + ircNick + '> ' + m.text;
    });
  }
  async onIrcAtSlackThread(ircUser, ircTarget, slackTarget, cmdArgs, cmdArgv) {
    const ts = cmdArgv.shift();
    const replies = await ircUser.slackWeb.apiCallOrThrow('conversations.replies', {
      channel: slackTarget,
      ts: ts,
      limit: cmdArgs['limit'] || cmdArgs['l'] || 1,
    });
    return replies.messages.map(h => JSON.stringify(h));
  }
  async onIrcAtSlackReact(ircUser, ircTarget, slackTarget, cmdArgs, cmdArgv) {
    return await this.onIrcAtSlackReactUnreact(ircUser, ircTarget, slackTarget, cmdArgs, cmdArgv, 'reactions.add');
  }
  async onIrcAtSlackUnreact(ircUser, ircTarget, slackTarget, cmdArgs, cmdArgv) {
    return await this.onIrcAtSlackReactUnreact(ircUser, ircTarget, slackTarget, cmdArgs, cmdArgv, 'reactions.remove');
  }
  async onIrcAtSlackReactUnreact(ircUser, ircTarget, slackTarget, cmdArgs, cmdArgv, reactMethod) {
    await ircUser.slackWeb.apiCallOrThrow(reactMethod, {
      channel: slackTarget,
      timestamp: cmdArgv.shift(),
      name: cmdArgv.shift(),
    });
    return [];
  }
  parseAtSlackCmd(cmdStr) {
    let cmdArgv = [];
    let cmdArgs = {};
    let token = '';
    let argToken = false;
    let inEscape = false;
    let inQuote = false;
    let inArg = false;
    const processToken = () => {
      if (!inQuote && token.trim() === '') {
        'Hi mom';
      } else if (inArg) {
        argToken = token;
        cmdArgs[argToken] = true;
        inArg = false;
      } else if (argToken) {
        cmdArgs[argToken] = token;
        argToken = false;
      } else {
        cmdArgv.push(token);
      }
      token = '';
    };
    for (let i = 0; i < cmdStr.length; i++) {
      const c = cmdStr.substr(i, 1);
      if (inEscape) {
        token += c;
        inEscape = false;
      } else if (c === '\\') {
        inEscape = true;
      } else if (!inQuote && (c === '"' || c === "'")) {
        processToken(token);
        inQuote = c;
      } else if (c === inQuote) {
        processToken(token);
        inQuote = false;
      } else if (token === '' && c === '-') {
        inArg = true;
      } else if (inArg && !inQuote && c === '=') {
        processToken(token);
      } else if (!inQuote && c.trim() === '') {
        processToken(token);
      } else {
        token += c;
      }
    }
    processToken(token);
    return [ cmdArgs, cmdArgv ];
  }
  onIrcDebugPrivmsg(ircUser, msg) {
    let cmd = msg.args[0];
    let out = null;
    const iOpts = { depth: 3, showHidden: true };
    switch (cmd) {
      case 'dump_server': out = util.inspect(this, iOpts);             break;
      case 'dump_user':   out = util.inspect(ircUser, iOpts);          break;
      case 'dump_rtm':    out = util.inspect(ircUser.slackRtm, iOpts); break;
      case 'dump_web':    out = util.inspect(ircUser.slackWeb, iOpts); break;
    }
    if (out) console.log('debug', cmd, out);
  }
  onIrcDebugJoin(ircUser) {
    this.sendIrcChannelJoin(ircUser, debugChannel, 'irslackd debug', [ ircUser.ircNick ]);
  }
  onIrcDebugPart(ircUser) {
    this.sendIrcChannelPart(ircUser, debugChannel);
  }
  async onIrcLine(ircUser, line) {
    console.log('irc_in', line);
  }
  async onIrcError(ircUser, err) {
    console.log('irc_err', err);
  }
  async onSlackEvent(ircUser, eventName, event) {
    console.log('slack_in', eventName, util.inspect(event));
  }
  async resolveSlackTarget(ircUser, event) {
    let ircNick = null;
    let ircChan = null;
    if (event.user) {
      ircNick = this.resolveSlackUser(ircUser, event.user);
    } else if (event.bot_id) {
      ircNick = this.resolveSlackBot(ircUser, event.bot_id);
    } else if (event.previous_message && event.previous_message.bot_id) {
      ircNick = this.resolveSlackBot(ircUser, event.previous_message.bot_id);
    } else if (event.previous_message && event.previous_message.username) {
      ircNick = event.previous_message.username;
    } else if (event.username) {
      ircNick = event.username;
    } else {
      // Slack sometimes sends events that are unattributable. We could
      // potentially lookup conversation history at this point to figure out the
      // user/bot. However, this is pretty infrequent overall, and I've only
      // seen this behavior with bots, so let's give up.
      this.logError(ircUser, 'Could not resolveSlackTarget for event: ' + util.inspect(event));
      ircNick = 'unknown';
    }
    if (event.channel) {
      ircChan = this.resolveSlackChannel(ircUser, event.channel);
    }
    try {
      if (ircNick) ircNick = await ircNick;
      if (ircChan) ircChan = await ircChan;
    } catch (e) {
      this.logError(ircUser, util.inspect(e));
    }
    return [ ircNick, ircChan ];
  }
  async resolveSlackChannel(ircUser, slackChan) {
    // Check cache
    let ircChan = ircUser.slackToIrc.get(slackChan);
    if (ircChan) return ircChan;

    // Try conversations.info
    let convo = await ircUser.slackWeb.apiCallOrThrow('conversations.info', { channel: slackChan });

    // If it's an im, pass to resolveSlackUser
    if (convo.channel.is_im) {
      return this.resolveSlackUser(ircUser, convo.channel.user);
    }

    // Set cache; return
    ircChan = '#' + this.replaceIllegalIrcChanChars(convo.channel.name);
    ircUser.mapIrcToSlack(ircChan, slackChan);
    return ircChan;
  }
  async resolveSlackUser(ircUser, slackUser) {
    // Check cache
    let ircNick = ircUser.slackToIrc.get(slackUser);
    if (ircNick) return ircNick;

    // Delegate to resolveSlackBot if it looks like a bot_id
    if (slackUser.substr(0, 1) === 'B') {
      return await this.resolveSlackBot(ircUser, slackUser);
    }

    // Try users.info
    let user = await ircUser.slackWeb.apiCallOrThrow('users.info', { user: slackUser });

    // Set cache; return
    ircNick = this.replaceIllegalIrcNickChars(user.user.name);
    ircUser.mapIrcToSlack(ircNick, slackUser);
    return ircNick;
  }
  async resolveSlackBot(ircUser, slackBotId) {
    // Check cache
    let ircNick = ircUser.slackToIrc.get(slackBotId);
    if (ircNick) return ircNick;

    // Try bots.info
    let bot = await ircUser.slackWeb.apiCallOrThrow('bots.info', { bot: slackBotId });

    // Set cache; return
    ircNick = this.replaceIllegalIrcNickChars(bot.bot.name);
    ircUser.mapIrcToSlack(ircNick, bot.bot.user_id || slackBotId);
    return ircNick;
  }
  logError(ircUser, err) { // TODO warn, info, error
    // Log trace to console
    console.trace('irslackd_err', err);

    // Log to debug channel if needed
    this.maybeSendIrcDebug(ircUser, '[E]', err);
  }
  maybeSendIrcDebug(ircUser, prefix, debugStr) {
    // Write to debug channel if needed
    if (!ircUser.isInChannel(debugChannel)) return;
    debugStr = '@' + ircUser.ircNick + ': ' + debugStr;
    debugStr.split(/\n/).forEach((debugLine, idx) => {
      for (let i = 0; i < debugLine.length; i += 256) {
        this.ircd.write(ircUser.socket, 'irslackd', 'PRIVMSG', [
          debugChannel,
          prefix + ' ' + debugLine.substr(i, 256),
        ]);
      }
    });
  }
  sendIrcChannelJoin(ircUser, ircChan, topic, ircNicks) {
    // Bail if already in
    if (ircUser.isInChannel(ircChan)) {
    //  return;
    }

    // Set channel marker
    ircUser.joinChannel(ircChan, ircNicks);

    // Join IRC channel
    this.ircd.write(ircUser.socket, ircUser.ircNick, 'JOIN', [ ircChan ]);
    if (topic) {
      topic = this.ircizeText(ircUser, topic);
      this.ircd.write(ircUser.socket, 'irslackd', '332', [ ircUser.ircNick, ircChan, ':' + topic ]);
    }

    // Send nicks in chunks of 20
    let nickChunkSize = 20;
    for (let i = 0; i < ircNicks.length; i += nickChunkSize) {
      this.ircd.write(ircUser.socket, 'irslackd', '353', [
        ircUser.ircNick,
        '=',
        ircChan,
        ircNicks.slice(i, i + nickChunkSize).map((ircNick) => {
          return ircUser.ircNickActive.has(ircNick) ? '+' + ircNick : ircNick;
        }).join(' '),
      ]);
    }
  }
  sendIrcChannelPart(ircUser, ircChan) {
    // Unset channel marker and leave IRC channel
    if (ircUser.partChannel(ircChan)) {
      this.ircd.write(ircUser.socket, ircUser.ircNick, 'PART', [ ircChan ]);
    }
  }
  updatePresenceSubscriptions(ircUser) {
    if (!ircUser.presenceEnabled()) {
      return;
    }
    let userIds = ircUser.getAllSlackUserIds();
    console.log('Subscribing to presence of', userIds.length, 'users');
    ircUser.slackRtm.subscribePresence(userIds);
  }
  ctcpCommand(command, text) {
    return String.fromCharCode(1) + command + ' ' + text + String.fromCharCode(1);
  }
  isCtcpCommand(command, message) {
    command = command + ' ';
    return message.charCodeAt(0) === 1 && message.substr(1, command.length) === command;
  }
  meText(text) {
    return this.ctcpCommand('ACTION', text);
  }
  typingText(level) {
    return this.ctcpCommand('TYPING', level);
  }
  decodeEntities(text) {
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    return text;
  }
  ircizeText(ircUser, text) {
    text = this.decodeEntities(text);
    if (text.indexOf('`') === -1) {
      return this.ircizeTextChunk(ircUser, text);
    }
    let tripleBacktickChunks = text.split('```');
    for (let i3 = 0; i3 < tripleBacktickChunks.length; i3++) {
      const inTripleBacktick = (i3 % 2 === 1 && i3 < tripleBacktickChunks.length - 1);
      if (inTripleBacktick) {
        tripleBacktickChunks[i3] = '```' + tripleBacktickChunks[i3];
      } else {
        let singleBacktickChunks = tripleBacktickChunks[i3].split('`');
        for (let i1 = 0; i1 < singleBacktickChunks.length; i1++) {
          const inSingleBacktick = (i1 % 2 === 1 && i1 < singleBacktickChunks.length - 1);
          if (inSingleBacktick) {
            singleBacktickChunks[i1] = '`' + singleBacktickChunks[i1];
          } else {
            singleBacktickChunks[i1] = (i1 > 0 ? '`' : '') + this.ircizeTextChunk(ircUser, singleBacktickChunks[i1]);
          }
        }
        tripleBacktickChunks[i3] = (i3 > 0 ? '```' : '') + singleBacktickChunks.join('');
      }
    }
    return tripleBacktickChunks.join('');
  }
  ircizeTextChunk(ircUser, text) {
    if (text.indexOf('<') === -1) return text;
    return text.replace(/<(http|mailto:|#|@|!subteam\^)([^>|]+)[^>]*>/g, (match, prefix, slackId) => {
      if (prefix === 'http') {
        let link = match.substr(1, match.length - 2);
        let pipe = link.lastIndexOf('|');
        if (pipe >= 0) link = '<' + link.substr(0, pipe) + '> ' + '(' + link.substr(pipe + 1) + ')';
        return link;
      } else if (prefix === 'mailto:') {
        return slackId;
      }
      let ircTarget = ircUser.slackToIrc.get(slackId); // TODO resolveSlackTarget?
      if (!ircTarget) return match;
      if (prefix === '!subteam^') {
        prefix = '@';
      } else if (prefix === '#') {
        prefix = ''; // Already part of ircTarget
      }
      return ircTarget ? (prefix + ircTarget) : match;
    });
  }
  slackizeText(ircUser, text) {
    if (text.indexOf('@') === -1 && text.indexOf('#') === -1) return text;
    return text.replace(/([^\w-]|^)([#@])([\w-]+)/g, (match, lookbehind, prefix, ircTarget) => {
      if (prefix === '#') ircTarget = '#' + ircTarget;
      let slackTarget = ircUser.ircToSlack.get(ircTarget);
      if (!slackTarget) {
        this.logError(ircUser, 'No slackizeText match for: ' + ircTarget);
        return match;
      }
      let suffix = '';
      if (prefix === '#') {
        prefix = '#';
        suffix = '|' + ircTarget.substr(1);
      } else if (slackTarget.substr(0, 1) === 'U') {
        prefix = '@';
      } else {
        prefix = '!subteam^';
        suffix = '|@' + ircTarget;
      }
      return lookbehind + '<' + prefix + slackTarget + suffix + '>';
    });
  }
  replaceIllegalIrcNickChars(ircNick) {
    return ircNick.replace(/[^a-zA-Z0-9_\\\[\]{}`|-]/g, '_');
  }
  replaceIllegalIrcChanChars(ircChan) {
    return ircChan.replace(/[\x00\x07\x0a\x0d ,:]/g, '_');
  }
  extractThread(text) {
    let re = /^@thread-([^ ]+) /;
    let match = re.exec(text);
    if (match) {
      return [ text.replace(re, ''), match[1] ];
    }
    return [ text, null ];
  }
  async rememberSelfEcho(ircUser, message, apiCb) {
    await ircUser.selfEchoLock.acquireAsync();
    try {
      let chat = await apiCb();
      let maxSelfEchoEntries = 1024;
      ircUser.selfEchoList.unshift(this.selfEchoKeyFromEvent(chat, message));
      ircUser.selfEchoList = ircUser.selfEchoList.slice(0, maxSelfEchoEntries);
    } finally {
      ircUser.selfEchoLock.release();
    }
  }
  async preventSelfEcho(ircUser, event, message) {
    let shouldSkipMessage = false;
    if (event.user !== ircUser.slackUserId) {
      return shouldSkipMessage;
    }
    await ircUser.selfEchoLock.acquireAsync();
    let idx = ircUser.selfEchoList.indexOf(this.selfEchoKeyFromEvent(event, message));
    if (idx >= 0) {
      ircUser.selfEchoList.splice(idx, 1);
      shouldSkipMessage = true;
    }
    ircUser.selfEchoLock.release();
    return shouldSkipMessage;
  }
  selfEchoKeyFromEvent(event, message) {
    let key = [];
    if (event.channel) key.push(event.channel);
    if (event.ts) key.push(event.ts);
    return key.join('|');
  }
  makeIrcHandler(method, requireInit) {
    const self = this;
    return async function() {
      const args = Array.from(arguments);
      const socket = args.shift();
      const ircUser = self.socketMap.get(socket);
      if (ircUser) {
        if (requireInit) {
          await ircUser.initialized();
        }
        args.unshift(ircUser);
        let res = method.apply(self, args);
        if (typeof res === 'object' && typeof res.catch === 'function') {
          res.catch((e) => {
            self.logError(ircUser, 'Failed ' + method.name + ': ' + util.inspect(e));
          });
        }
      } else {
        self.logError(null, 'Could not find user state for socket ' + socket);
      }
    };
  }
  makeSlackHandler(method) {
    const self = this;
    return function() {
      const args = Array.from(arguments);
      const rtm = this;
      const ircUser = self.rtmMap.get(rtm);
      if (ircUser) {
        args.unshift(ircUser);
        let res = method.apply(self, args);
        if (typeof res === 'object' && typeof res.catch === 'function') {
          res.catch((e) => {
            self.logError(ircUser,
              'Failed ' + method.name + ' args=' + util.inspect(args.slice(1)) +
              ' err=' + util.inspect(e)
            );
          });
        }
      } else {
        self.logError(null, 'Could not find user state for rtm ' + rtm);
      }
    };
  }
  async apiCallOrThrow(method, options) {
    console.log('slack_out', method, util.inspect(options));
    let result;
    try {
      result = await this.apiCall(method, options);
      if (!result.ok) throw result;
    } catch (e) {
      throw Error(JSON.stringify({
        method: method,
        options: options,
        error: e,
      }, null, 2));
    }
    return result;
  }
  async paginateCallOrThrow(method, aggKey, options) {
    let results, result;
    options = options || {};
    while (1) {
      result = await this.apiCallOrThrow(method, options);
      if (!results) {
        results = result;
      } else {
        results[aggKey] = results[aggKey].concat(result[aggKey]);
      }
      if (!result.response_metadata
         || !result.response_metadata.next_cursor
         || result.response_metadata.next_cursor.length < 1
      ) {
        break;
      }
      options.cursor = result.response_metadata.next_cursor;
    }
    return results;
  }
  async setSlackPresence(ircUser, active) {
    let status = (active) ? 'auto' : 'away';
    await ircUser.slackWeb.apiCallOrThrow('users.setPresence', { presence: status });
  }
  // Dependency injectors
  getNewIrcd(tlsOpts) {
    return new ircd.Ircd(tlsOpts);
  }
  getNewSlackWebClient(token) {
    return new slack.WebClient(token);
  }
  getNewSlackRtmClient(token) {
    return new slack.RTMClient(token, {
      logLevel: this.config.rtmClientLogLevel || 'info',
      retryConfig: { forever: true, maxTimeout: 60000 },
    });
  }
}

class IrcUser {
  constructor(socket) {
    const self = this;
    this.socket = socket;
    this.ircNick = 'user';
    this.slackToken = 'token';
    this.slackUserId = 'uid';
    this.slackWeb = null;
    this.slackRtm = null;
    this.channelNicks = new Map();
    this.ircToSlack = new Map();
    this.slackToIrc = new Map();
    this.ircNickToSlackChanId = new Map();
    this.ircNickActive = new Set();
    this.selfEchoList = [];
    this.selfEchoLock = new AwaitLock();
    this.typingTimer = null;
    this.preferences = [];
    this.initializeResolveFn = null;
    this.initializePromise = new Promise((resolve, reject) => {
      self.initializeResolveFn = resolve;
    });
  }
  setInitialized() {
    this.initializeResolveFn(true);
  }
  async initialized() {
    return await this.initializePromise;
  }
  isInChannel(ircChan) {
    return this.isNickInChannel(ircChan, this.ircNick);
  }
  isNickInChannel(ircChan, ircNick) {
    const chanMap = this.channelNicks.get(ircChan);
    return chanMap && chanMap.get(ircNick);
  }
  joinChannel(ircChan, ircNicks) {
    this.channelNicks.set(ircChan, new Map());
    ircNicks.forEach((ircNick) => {
      this.addNickToChannel(ircChan, ircNick);
    });
  }
  partChannel(ircChan) {
    return this.channelNicks.delete(ircChan);
  }
  addNickToChannel(ircChan, ircNick) {
    let nickMap = this.channelNicks.get(ircChan);
    if (!nickMap) {
      nickMap = new Map();
      this.channelNicks.set(ircChan, nickMap);
    }
    return nickMap.set(ircNick, true);
  }
  removeNickFromChannel(ircChan, ircNick) {
    let nickMap = this.channelNicks.get(ircChan);
    if (nickMap) {
      return nickMap.delete(ircNick, true);
    }
    return false;
  }
  getAllSlackUserIds() {
    let userIds = [];
    this.slackToIrc.forEach((ircNick, userId) => {
      if (userId[0] === 'U') {
        userIds.push(userId);
      }
    });
    return userIds;
  }
  reactionsEnabled() {
    return this.preferences.indexOf('no-reactions') === -1;
  }
  threadsEnabled() {
    return this.preferences.indexOf('no-threads') === -1;
  }
  debugChannelEnabled() {
    return this.preferences.indexOf('debug-chan') !== -1;
  }
  typingNotificationsEnabled() {
    return this.preferences.indexOf('typing-notifications') !== -1;
  }
  presenceEnabled() {
    return this.preferences.indexOf('presence') !== -1;
  }
  mapIrcToSlack(ircTarget, slackId) {
    let preSlackId = this.ircToSlack.get(ircTarget);
    if (preSlackId) {
      let preIrcTarget = this.slackToIrc.get(preSlackId);
      if (preIrcTarget !== ircTarget || preSlackId !== slackId) {
        console.trace('Overwriting IRC-Slack map entry; irc=(' + preIrcTarget + '=>' + ircTarget + ') slack=(' + preSlackId + '=>' + slackId + ')');
      }
    }
    this.ircToSlack.set(ircTarget, slackId);
    this.slackToIrc.set(slackId, ircTarget);
  }
}

exports.Irslackd = Irslackd;
