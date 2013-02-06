#!/usr/bin/env node

var argv = require("optimist")
  .usage("Usage: $0 -l token -a account -p project -g token -r repo")
  .demand(["l", "a", "p", "u", "m", "g", "r"])
  .describe({
    "l": "Lighthouse API token (see http://mzl.la/XlOiLs)",
    "a": "Lighthouse account (https://account.lighthouseapp.com)",
    "p": "Lighthouse project id (eg 63272)",
    "u": "Lighthouse user id to Github account map JSON file",
    "m": "Lighthouse milestone id to Github milestone map JSON file",
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

var userMap = require(argv.u),
    milestoneMap = require(argv.m);

var gh = new (require("github"))({
  version: "3.0.0"
});
gh.authenticate({
  type: "oauth",
  token: argv.g
});

async.parallel({
  "lighthouse": function(callback) {
    lh.listTickets({
      q: "sort:number-",
      limit: 1
    }, callback);
  },
  "githubOpen": function(callback) {
    gh.issues.repoIssues({
      user: argv.r.split("/")[0],
      repo: argv.r.split("/")[1],
      state: "open",
      per_page: 1,
      sort: "created",
      direction: "desc"
    }, callback);
  },
  "githubClosed": function(callback) {
    gh.issues.repoIssues({
      user: argv.r.split("/")[0],
      repo: argv.r.split("/")[1],
      state: "closed",
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
      maxGH = Math.max(results.githubOpen[0] ? results.githubOpen[0].number : 0,
                       results.githubClosed[0] ? results.githubClosed[0].number : 0);

  console.log("Lighthouse tickets: %d \n     Github issues: %d", maxLH, maxGH);

  if (maxLH <= maxGH) {
    throw "Can't import Lighthouse tickets when there are more Github issues";
  }

  var q = async.queue(function importer(task, qCallback) {
    async.waterfall([
      function(callback) {
        lh.getTicket({
          ticket: task
        }, callback)
      },
      function(ticket, callback) {
        console.log("Attempting to import ticket #" + ticket.number);

        var body = "";
        body += "[Original issue](" + ticket.url + ")\n\n";
        body += "Reported by: " + ticket.creator_name + " @ " + ticket.created_at + "\n";
        body += "---\n";
        if (ticket.latest_body) {
          body += ticket.latest_body.replace(/@@@/g,'```')
        }
        body += "\n\n";

        // Skip the first "version" since it's the original ticket
        ticket.versions.slice(1).forEach(function(ticket) {
          body += ticket.user_name + " @ " + ticket.created_at + "\n";
          body += "---\n";
          if (ticket.body) {
            body += ticket.body.replace(/@@@/g,'```');
          }
          body += "\n\n";
        });

        gh.issues.create({
          user: argv.r.split("/")[0],
          repo: argv.r.split("/")[1],
          title: ticket.title,
          labels: ["imported", ticket.state],
          milestone: milestoneMap[ticket.milestone_id],
          body: body
        }, function(err, issue) {
          callback(err, ticket, issue);
        });
      },
      function(ticket, issue, callback) {
        // Sanity check, we can stop here and restart later.
        if (ticket.number !== issue.number) {
          console.warn("Github issue #" + issue.number + " doesn't match Lighthouse ticket #" +ticket.number);
          //throw "Github issue #" + issue.number + " doesn't match Lighthouse ticket #" +ticket.number;
        }

        if (ticket.closed) {
          gh.issues.edit({
            user: argv.r.split("/")[0],
            repo: argv.r.split("/")[1],
            number: issue.number,
            assignee: userMap[ticket.assigned_user_id],
            state: "closed"
          }, function(err, newIssue) {
            callback(err, newIssue);
          });
          return;
        }

        callback(null, issue);
      }
    ], function(err, result) {
      if (err) {
        throw err;
      }

      console.log("Successfully imported issue #" + result.number);
      qCallback();
    });
  }, 1);

  for (var start = maxGH + 1, end = maxLH; start <= end; start++) {
    q.push(start);
  }
  console.log(q.length());
});

