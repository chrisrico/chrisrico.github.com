const params = (new URL(document.location)).searchParams;
const submission = params.get('submission');
const endTime = new Date(params.get('endTime') || new Date());
const endTimestamp = endTime.getTime() / 1000;
const count = parseInt(params.get('count') || 1);

const userCache = new Cache('user-cache');

let requirements = Promise.resolve([
	new requirement('submission', !submission || !submission.match(/^[a-z0-9]+$/i)),
	new requirement('endTime', isNaN(endTime), '(example: 2018-12-30T12:00)'),
	new requirement('count', isNaN(count) || count < 1)
]);

requirements
	.then(validateInputs)		// 0. Validate inputs
	.then(getAccessToken)		// 1. Get an anonymous access token
	.then(fetchSubmission)		// 2. Fetch the submission
	.then(fetchAllComments)		// 3. Fetch all the root level comments
	.then(getUniqueComments)	// 4. Print a list of valid, unique comments
	.then(pickEntries)			// 5. Pick the winners
	.catch(handleErrors);

function validateInputs(requirements) {
	let errors = requirements
		.filter(({predicate}) => predicate)
		.map(r => r.render())
		.reduce($.merge, $());

	if (errors.length > 0) throw errors;
}

function getAccessToken() {
	return $.ajax('https://www.reddit.com/api/v1/access_token', {
		type: 'POST',
		data: {
			grant_type: 'https://oauth.reddit.com/grants/installed_client',
			device_id: 'DO_NOT_TRACK_THIS_DEVICE'
		},
		headers: {
			authorization: `Basic ${ btoa('0Ry1TaKGFLtP5Q:') }`,
		}
	});
}

function fetchSubmission(data) {
	// Setup the API client
	const r = window.r = new snoowrap({
		userAgent: 'reddit-raffle',
		accessToken: data.access_token
	});
	r.config({ proxies: false, requestDelay: 50 });

	// fetch the submission
	return r.getSubmission(submission).fetch();
}

function fetchAllComments(submission) {
	if (submission.created_utc >= endTimestamp) throw "submission created after 'endTime'";

	let subreddit = submission.subreddit.display_name,
		title = submission.title,
		startTime = new Date(submission.created_utc * 1000);

	Object.entries({subreddit, submission: submission.id, title, startTime, endTime, count})
		.map(([k, v]) => dd(k, v || '&nbsp;'))
		.reduce($.merge, $())
		.appendTo('#params')

	$('#status').text('Fetching comments...');

	// fetch all the root level comments
	return submission.comments.fetchAll({skipReplies: true}).then(comments => ({
		submission,
		comments
	}));
}

function getUniqueComments({submission, comments}) {
	// unique, valid comments
	let uniqueComments = Object.values(comments
		.filter(isValidComment)
		// only keep one entry per user
		.reduce(unique, {}));

	// For each comment, fetch the user
	// Waits for all operations to complete
	return Promise.all(uniqueComments.map((comment, i) => {
		return userCache
			.get(comment.author.name, function () {
				if (comment.author.name === '[deleted]')
					return Promise.resolve();
				return comment.author.fetch()
			}).then(function (user) {
				let add = () => addEntry('entries', i, dd(comment.id, comment.author.name));
				if (user) {
					$('#status').text(`Fetched user ${i + 1} of ${uniqueComments.length}...`);
					if (isValidEntry({submission, comment, user})) add();
					return {submission, comment, user};
				} else {
					add();
					return {submission, comment};
				}
			});
	}));
}

function pickEntries() {
	$('#status').text('Done!');

	$('#entries div')
		.sort((a, b) => {
			let i = x => parseInt($(x).attr('data-index'));
			return i(a) - i(b);
		})
		// shuffle them
		.shuffle()
		.filter(':not(:contains("[deleted]"))')
		.find('dd')
		// take the first three
		.slice(0, count)
		.addClass('winner');
}

function handleErrors(err) {
	if (err instanceof $) {
		$('#status *').remove();
		$('#status').append(err);
	} else {
		$('#status').text(`Error: ${err}`);
	}
}

function isValidComment(comment) {
	// if the comment was created after the cutoff
	if (comment.created_utc > endTimestamp) {
		return reject(comment.id, comment.author.name, 'entered after deadline');
	}
	return true;
}

function isValidEntry({submission, comment, user}) {
	// if the account was created before your post
	if (user.created_utc > submission.created_utc) {
		return reject(comment.id, user.name, 'account too new');
	}
	return true;
}

function dd(id, name, reason) {
	reason = reason ? ` (${reason})` : '';
	return $('<div>').append($('<dt>').text(id)).append($('<dd>').text(`${name}${reason}`));
}

function addEntry(id, i, el) {
	let list = $(`#${id}`);
	if (i) el.attr('data-index', i)
	list.append(el);
	$(`#${id}Count`).text(`(${list.children().length})`);
}

// Log a rejected entry
function reject(id, name, reason) {
	addEntry('invalid', null, dd(id, name, reason));
}

function unique(unique, comment) {
	let name = comment.author.name;
	if (name !== '[deleted]' && name in unique) reject(comment.id, name, 'duplicate');
	else unique[name] = comment;
	return unique;
}

function delay(milliseconds) {
	return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function requirement(name, predicate, help) {
	this.name = name;
	this.predicate = predicate;
	this.help = help || '';
}

requirement.prototype.render = function () {
	return $('<div>').text(`Invalid parameter ${this.name} ${this.help}`);
};

/**
 * Creates a pseudo-random value generator. The seed must be an integer.
 *
 * Uses an optimized version of the Park-Miller PRNG.
 * http://www.firstpr.com.au/dsp/rand31/
 */
function Random(seed) {
	this._seed = seed % Random.max + 1;
	if (this._seed <= 0) this._seed += Random.max;
}

Random.max = 2147483646

/**
 * Returns a pseudo-random value between 1 and 2^32 - 2.
 */
Random.prototype.next = function () {
	return this._seed = this._seed * 16807 % Random.max + 1;
};

/**
 * Returns a pseudo-random floating point number in range [0, 1).
 */
Random.prototype.nextFloat = function (opt_minOrMax, opt_max) {
	// We know that result of next() will be 1 to 2147483646 (inclusive).
	return (this.next() - 1) / Random.max;
};

function Cache(storageKey) {
	this._storageKey = storageKey;
	this._cache = JSON.parse(localStorage.getItem(storageKey)) || {}
}

Cache.prototype.get = function(key, promiser) {
	if (key in this._cache) return Promise.resolve(this._cache[key]);
	return promiser().then(value => {
		this._cache[key] = value;
		localStorage.setItem(this._storageKey, JSON.stringify(this._cache));
		return value;
	});
}

// Fishers-Yates (Knuth) Shuffle
// https://stackoverflow.com/a/2450976
// modified to be deterministic
$.fn.shuffle = function() {
	let random = new Random(parseInt(submission, 36)),
		swap = x => x,
		currentIndex = this.length,
		temporaryValue, randomIndex;

	// While there remain elements to shuffle...
	while (0 !== currentIndex) {
		// Pick a remaining element...
		randomIndex = Math.floor(random.nextFloat() * currentIndex);
		currentIndex -= 1;
		// And swap it with the current element.
		this[randomIndex] = swap(this[currentIndex], this[currentIndex] = this[randomIndex])
	}

	this.each(function () {
		this.parentElement.appendChild(this);
	});

	return this;
}
