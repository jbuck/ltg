#!/usr/bin/env node

var argv = require("optimist")
  .usage("Usage: $0 -l token -a account -p project -g token -r repo")
  .demand(["l", "a", "p", "u", "g", "r"])
  .describe({
    "l": "Lighthouse API token (see http://mzl.la/XlOiLs)",
    "a": "Lighthouse account (https://account.lighthouseapp.com)",
    "p": "Lighthouse project id (eg 63272)",
    "u": "Lighthouse user id to Github account map JSON file",
    "g": "Github API token (see https://npmjs.org/package/ghtoken)",
    "r": "Github repository (eg mozilla/popcornjs)"
  })
  .argv;

var async = require("async");

var lh = require("lighthouse-client").createClient({
  token: argv.l,
  account: argv.a,
  project: argv.p
});

var userMap = require(argv.u);

var gh = new (require("github"))({
  version: "3.0.0"
});

async.parallel({
  "lighthouse": function(callback) {
    lh.listTickets({
      q: "sort:number-",
      limit: 1
    }, callback);
  },
  "github": function(callback) {
    gh.authenticate({
      type: "oauth",
      token: argv.g
    });
    gh.issues.repoIssues({
      user: argv.r.split("/")[0],
      repo: argv.r.split("/")[1],
      per_page: 1,
      sort: "created",
      direction: "desc"
    }, callback);
  }
}, function(err, results) {
  if (err) {
    throw err;
  }

  var maxLH = results.lighthouse[0].number,
      maxGH = results.github[0] ? results.github[0].number : 0;

  console.log("Lighthouse tickets: %d \n     Github issues: %d", maxLH, maxGH);

  if (maxLH <= maxGH) {
    throw "Can't import Lighthouse tickets when there are more Github issues";
  }

  var q = async.queue(function importer(task, callback) {
    async.waterfall([
      function(callback) {
        lh.getTicket({
          ticket: task
        }, callback)
      },
      function(ticket, callback) {
        var body = "";
        body += "[Original issue](" + ticket.url + ")\n\n";
        body += "Reported by: " + ticket.creator_name + " @ " + ticket.created_at + "\n";
        body += "---\n";
        body += ticket.latest_body.replace(/@@@/g,'```') + "\n\n";

        // Skip the first "version" since it's the original ticket
        ticket.versions.slice(1).forEach(function(ticket) {
          body += ticket.user_name + " @ " + ticket.created_at + "\n";
          body += "---\n";
          body += ticket.body.replace(/@@@/g,'```') + "\n\n";
        });

        gh.issues.create({
          user: argv.r.split("/")[0],
          repo: argv.r.split("/")[1],
          title: ticket.title,
          labels: ["imported"],
          milestone: ticket.milestone_title,
          assignee: userMap[ticket.assigned_user_id],
          body: body
        }, function(err, data) {
          callback(err, data);
        });
      },

    ], function(err, result) {
      console.log("waterfall done");
      console.log(arguments);
    });
  }, 1);

  q.drain = function() {
    console.log("All items imported!");
  };

  /*
  var tickets = [];
  for (var start = maxGH + 1, end = maxLH; start <= end; start++) {
    tickets.push(start);
  }
  */

  q.push(922);
});

