const StatsD = require('node-statsd');

const statsd = new StatsD({
  host: 'localhost',
  port: 8125
});

function trackMetric(name, value, tags = []) {
  statsd.gauge(name, value, tags);
}

module.exports = { statsd, trackMetric };