const express = require("express");
const request = require("request");
const crypto = require("crypto");
const uuid = require("uuid");
const https = require("https");
const querystring = require("querystring");
const fs = require("fs");
const MongoClient = require("mongodb").MongoClient;
const sgMail = require('@sendgrid/mail');

var port = process.env.PORT || 3000;
var app = express();

console.log("listening on port " + port);

var hospitaldb = undefined;

const ZIPCODE_API_URL = "https://public.opendatasoft.com/api/records/1.0/search" 

/* Sam's Google API keys */
const GOOGLE_API_PUBLIC_KEY  = "AIzaSyAg26nFAerS2R5la5jCQVBjps6GihQ_M2I";

/* Twitter info: @PPE_Donations, foreverdevtesting1@gmail.com */
const TWITTER_QUERY_DELTATIME     = 22;
const TWITTER_PUBLIC_APP_KEY      = "LXb0G7lz2YrFDGitD7HXfuLjE";
const TWITTER_PRIVATE_APP_KEY     = "AI1k2QMbC3l720mj96lWoUKOIkmFtLzvPQPO4wmiU1kAbLDRt9";
const TWITTER_PUBLIC_ACCESS_KEY   = "1249635192588906496-Ex70fz5hjzFQDP3eHJi8AUycHHHb28";
const TWITTER_PRIVATE_ACCESS_KEY  = "fvweyXVi8GQIzVQlz7kRs6HEMWVlUErKs5UcX0HNE1iN2";

/* twitter database constants */
const MONGO_URL = "mongodb+srv://ppe_donations:x90BZh8izdMUng3u@cluster0-dyeyk.mongodb.net/test?retryWrites=true&w=majority";
const DB_NAME = "ppe_donations";
const COLLECTION_NAME = "tweets";


function allowCrossDomain(req, res, next) {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Method", "GET,PUT,POST,OPTIONS");
	res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Content-Length, X-Requested-With");

	/* intercept OPTIONS */
	if (req.method == "OPTIONS") {
		res.send(200);
	} else {
		next();
	}
}

function extractHospitalJSON(hospitalData) {
	return {
		name:        hospitalData.NAME || "( ? )",
		latitude:    hospitalData.LATITUDE || 0,
		longitude:   hospitalData.LONGITUDE || 0,
		address:     hospitalData.ADDRESS || "( ? )",
		city:        hospitalData.CITY || "( ? )",
		state:       hospitalData.STATE || "( ? )",
		zip:         hospitalData.ZIP || "( ? )",
		website:     hospitalData.WEBSITE || "( ? )",
		phoneNumber: hospitalData.GRABBED_PHONE_NUMBER || "Unavailable"
	};
}

function getSingleNearestHospital(lat, lon) {
	var hospitals = hospitaldb.features;
  var smallestDist = 1000;
  var closestHospital = undefined;
  for (var i in hospitals) {
    var prop = hospitals[i].properties;
    var hospLat = prop.LATITUDE;
    var hospLon = prop.LONGITUDE;
    var dist = Math.sqrt(Math.pow(hospLat - lat, 2) + Math.pow(hospLon - lon, 2));
    if (dist < smallestDist) {
      smallestDist = dist;
			closestHospital = extractHospitalJSON(prop);
    }
  }
  return [closestHospital];
}

function getNearestHospitalsN(lat, lon, n) {

	if (n > 30) {
		n = 30;
	}

	var hospitals = hospitaldb.features;
	hospitals.sort(function(a, b) {
		var propa = a.properties;
		var propb = b.properties;
		
		var coorda = [propa.LATITUDE, propa.LONGITUDE];
		var coordb = [propb.LATITUDE, propb.LONGITUDE];

		var da = Math.sqrt(Math.pow(coorda[0] - lat, 2) + Math.pow(coorda[1] - lon, 2));
		var db = Math.sqrt(Math.pow(coordb[0] - lat, 2) + Math.pow(coordb[1] - lon, 2));
		
		return (da < db) ? -1 : (da > db) ? 1 : 0;
	});

	var nearestHospitals = [];
	for (var i = 0; i < n; i++) {
		nearestHospitals.push(extractHospitalJSON(hospitals[i].properties));
	}

	return nearestHospitals;
}

function processHospitalQuery(lat, lon, n) {
	var num = n || 1;

	if (num == 1) {
		return getSingleNearestHospital(lat, lon);
	} else {
		return getNearestHospitalsN(lat, lon, n);
	}
}

function twitterDB_insertMentions(mentions) {

	var client = new MongoClient(MONGO_URL, {useNewUrlParser: true});

	client.connect(MONGO_URL, function(err, db) {
		if (err) {
			console.log("error connecting to mongo: " + err);
			return;
		}
		db.db(DB_NAME).collection(COLLECTION_NAME).insertMany(mentions); 
	});
}

function twitterDB_getRecentMentions(n, callback) {
	var client = new MongoClient(MONGO_URL, {useNewUrlParser: true});
	
	client.connect(MONGO_URL, function(err, db) {
		if (err) {
			console.log("error connecting to mongo: " + err);
			callback(null);
			return;
		}

		var mydb = db.db(DB_NAME);
		var collection = mydb.collection(COLLECTION_NAME);

		collection.find().limit(n).sort({_id: -1}).toArray(function(err, result) {
			callback(result);
			mydb.close();
		});
	});
}

/* creates a Twitter authentication string that is needed in the
 * 'Authorization' header for every single API call.
 * see: https://developer.twitter.com/en/docs/basics/authentication/oauth-1-0a/authorizing-a-request
 *
 * httpMethod: GET or POST
 * baseURL: the twitter api URL, e.g. https://api.twitter.com/update.json
 * queryParams: dictionary of query parameters */
function createTwitterAuthenticationString(httpMethod, baseURL, queryParams) {

	/* the seven values needed for authentication.  see link above for more details */
	var oauth_values = {
		oauth_consumer_key:        TWITTER_PUBLIC_APP_KEY,
		oauth_nonce:               uuid.v4().replace(/\W/g, ""),
		oauth_signature:           undefined,
		oauth_signature_method:    "HMAC-SHA1",
		oauth_timestamp:           Math.round((new Date()).getTime() / 1000),
		oauth_token:               TWITTER_PUBLIC_ACCESS_KEY,
		oauth_version:             "1.0"
	} 
	
	/* performs percent-encoding according to RFC 3986, Section 2.1 */ 
	var encodeRFC3986 = function(str) {
		return encodeURIComponent(str).replace(/[!'()*]/g, function(c) {
			return '%' + c.charCodeAt(0).toString(16);
		});
	}
	
	/* ========================================================================== */
	/* signature generation */	
	/* see: https://developer.twitter.com/en/docs/basics/authentication/oauth-1-0a/creating-a-signature */

	/* percent encode every key, value (including query parameters) */	
	var allKeys = {};
	for (var i in queryParams) {
		allKeys[encodeRFC3986(i)] = encodeRFC3986(queryParams[i]);
	}
	for (var i in oauth_values) {
		if (oauth_values[i] == undefined) {
			continue;
		}
		allKeys[encodeRFC3986(i)] = encodeRFC3986(oauth_values[i]);
	}

	/* alphabetically sort keys.  this is necessary for authentication */
	const ordered = {}
	Object.keys(allKeys).sort().forEach(function(key) {
		ordered[key] = allKeys[key];
	});
	allKeys = ordered;
	
	/* append all query params and oauth_values to paramString */
	var paramString = "";
	for (var key in allKeys) {
		paramString += (key + "=" + allKeys[key]);
		paramString += "&";
	}
	paramString = paramString.substring(0, paramString.length - 1);

	/* generate signature base string, see link above */
	var sigBaseString = httpMethod.toUpperCase();
	sigBaseString += "&";
	sigBaseString += encodeRFC3986(baseURL);
	sigBaseString += "&";
	sigBaseString += encodeRFC3986(paramString);

	/* generate signingKey, which is used as the secret SHA1 encription key */
	var signingKey = encodeRFC3986(TWITTER_PRIVATE_APP_KEY);
	signingKey += "&";
	signingKey += encodeRFC3986(TWITTER_PRIVATE_ACCESS_KEY);

	/* perform HMAC-SHA1 hashing on sigBaseString, with signingKey as the key...
	 * also perform base64 encoding on the hex-array result */
	var hmac = crypto.createHmac("sha1", signingKey);
	hmac.update(sigBaseString);
	oauth_values.oauth_signature = Buffer.from(hmac.digest("hex"), "hex").toString("base64");
	
	/* ========================================================================== */
	/* signature generation is complete.  Now, we can generate the authentication string */

	var DST = "OAuth ";
	for (var key in oauth_values) {
		DST += (encodeRFC3986(key) + '="' + encodeRFC3986(oauth_values[key]) + '", ');
	}
	DST = DST.substring(0, DST.length - 2);

	return DST; 
}

function getAverageCoordinates(coords) {
	const avg = {
		latitude: 0.0,
		longitude: 0.0
	};
	for (var i in coords) {
		avg.latitude += coords[i][1]/coords.length;
		avg.longitude += coords[i][0]/coords.length;
	} 
	return avg;
}

function camelCaseName(str) {
	str = str.toLowerCase().split(" ");
	for (var i = 0; i < str.length; i++) {
		if (str[i] != "") {
			str[i] = str[i][0].toUpperCase() + str[i].substr(1);
		}
		
	}
	return str.join(" ");
}

function sendTweet(targetUser, enabledLocationServices, lat, lon) {

	var tweetStatus;

	if (!enabledLocationServices) {
		tweetStatus = "Hey @" + targetUser + ", we can't see where you are!" +
									"  Please tweet us again with your 5 digit zipcode. If you'd like to keep your" +
									" location private, check out our website: https://www.ppe-donations.com"
	} else {
		var nearestHospital = getSingleNearestHospital(lat, lon)[0];
		if (nearestHospital.phoneNumber == "Unavailable") {
			tweetStatus = "Hey, @" + targetUser + "!  The hospital closest to you is " +
										camelCaseName(nearestHospital.name) + ".  They are located at " + 
										camelCaseName(nearestHospital.address) + ", " + camelCaseName(nearestHospital.city) +
										", " + nearestHospital.state + " " + nearestHospital.zip + ".  " +
										"You can find their contact information on their website: " + nearestHospital.website; 
		} else {
			tweetStatus = "Hey, @" + targetUser + "!  The hospital closest to you is " +
										camelCaseName(nearestHospital.name) + ".  They are located at " + 
										camelCaseName(nearestHospital.address) + ", " + camelCaseName(nearestHospital.city) +
										", " + nearestHospital.state + " " + nearestHospital.zip + ".  " +
										"You can call them at " + nearestHospital.phoneNumber + " or check out their website: " + 
										nearestHospital.website; 
		}
	}

	const url = "https://api.twitter.com/1.1/statuses/update.json";
	const form = {
		status: tweetStatus
	};
	const authString = createTwitterAuthenticationString("POST", url, form);
	const headers = {
		Authorization: authString
	}

	request.post({url: url, form: form, headers: headers}, function(err, res, body) {
		if (res.statusCode == 200) {
			console.log("successfully posted tweet: " + tweetStatus);
		} else {
			console.log("failed to post tweet to user " + targetUser);
		}
	});
}

function pullTwitterMentions() {

	const url = "https://api.twitter.com/1.1/statuses/mentions_timeline.json";	
	const query = {
		tweet_mode: "extended",
		count: 20
	};
	const authString = createTwitterAuthenticationString("GET", url, query);
	const headers = {
		Authorization: authString
	};

	var twitterDateToTimestamp = function(twitterDate) {
		return Math.round(new Date(Date.parse(twitterDate.replace(/( \+)/, " UTC$1"))).getTime() / 1000);
	}

	request({url: url, qs: query, headers: headers}, function(err, res, body) {

		if (err) {
			console.log("Twitter pull error: " + err);
			return;
		}
		if (res.statusCode != 200) {
			console.log("Got bad status code from Twitter: " + res.statusCode);
			console.log("Got body: " + body);
			return;
		}

		var findZipCode = function(str) {
			var zipcodeRegex = /\d{5}-\d{4}|\d{5}|[A-Z]\d[A-Z] \d[A-Z]\d/;
			var match = zipcodeRegex.exec(str);
			return match != null ? match[0] : null;
		}
		
		/* if the tweet was within TWITTER_QUERY_DELTATIME, it must be
		 * a new tweet.  anything older must have been processed in
		 * a previous iteration */
		var returnedMentions = JSON.parse(body);
		var timestamp = Math.round((new Date()).getTime() / 1000);
		var didFindNewTweet = false;
		let discoveredMentions = [];
		for (var i in returnedMentions) {
			let mention = returnedMentions[i];
			let mention_timestamp = twitterDateToTimestamp(mention.created_at);
			let zipcode = findZipCode(mention.full_text);
			if (Math.abs(timestamp - mention_timestamp) <= (TWITTER_QUERY_DELTATIME + 4)) { 
				didFindNewTweet = true;
				discoveredMentions.push(mention);
				console.log("found new tweet: " + mention.full_text);

				/* location coordinates embedded in tweet */
				if (mention.place != null) {
					let averageCoords = getAverageCoordinates(mention.place.bounding_box.coordinates[0]);
					sendTweet(mention.user.screen_name, true, averageCoords.latitude, averageCoords.longitude);

				/* zip code embedded in tweet, requires coordinate lookup */
				} else if (zipcode != null) {
					let zipcodeQuery = {
						dataset: "us-zip-code-latitude-and-longitude",
						rows: 1,
						q: zipcode
					};

					request({url: ZIPCODE_API_URL, qs: zipcodeQuery}, function(err, res, body) {
						let foundCoords = false;
						if (res.statusCode == 200) {
							let responseData = JSON.parse(body);
							if (responseData.nhits > 0) {
								let lat = responseData.records[0].fields.latitude;
								let lon = responseData.records[0].fields.longitude;
								sendTweet(mention.user.screen_name, true, lat, lon);	
								foundCoords = true;
							}
						}
						if (!foundCoords) {
							sendTweet(mention.user.screen_name, false);
						}
					});	

				/* no location information found */
				} else {
					sendTweet(mention.user.screen_name, false);
				}
			}
		}		
		if (!didFindNewTweet) {
			console.log("no new tweets found...");
		}

		/* insert new tweets into database */
		if (discoveredMentions.length > 0) {
			let dbInsertionData = [];
			for (var i in discoveredMentions) {
				let mention = discoveredMentions[i];
				dbInsertionData.push({
					text: mention.full_text,
					user: mention.user.screen_name,
					timestamp: twitterDateToTimestamp(mention.created_at),
					id: mention.id_str
				});
			}
			twitterDB_insertMentions(dbInsertionData);
		}
	});

}

function initDatabase() {
  let rawdata = fs.readFileSync("hospitaldb.json");
  hospitaldb = JSON.parse(rawdata);
	console.log("database read successfully");
}

/* send email with search results to user using mailgun */
function emailResults(hospData, user_email, n) {
	
	if (n > 30) {
		n = 30;
	}

	var str_hosp_info = "Thank you for your interest in donating PPE to hospitals. </br> As requested, here is the contact information for the " + n + " hospitals near you: <br><br>";

	// prettify the hospital data for emailing
	for (i in hospData) {

		var website_link = hospData[i].website;

		let info_window_text = "<b>"
							 + camelCaseName(hospData[i].name)
							 + "</b><br>"
							 + camelCaseName(hospData[i].address)
							 + "<br>"
							 + camelCaseName(hospData[i].city)
							 + ", "
							 + hospData[i].state
							 + ", "
							 + hospData[i].zip
							 + "<br>"
							 + "Phone Number: " + hospData[i].phoneNumber
							 + "<br>"
							 + "<a href='" + website_link + "'target='_blank'> 		Website link </a>";

		str_hosp_info += info_window_text + "<br> <br>";
	}
	str_hosp_info += "<i>Do a new search on our website <a href = 'https://samtufts.github.io/final/'>https://www.ppe-donations.com/</a></i>";

	console.log(str_hosp_info);;
	
	sendEmail(str_hosp_info, user_email);

}

function sendEmail(str_hosp_info, user_email) {
	console.log('inside sendEmail function');
	
	console.log('user email: ', user_email);
	
	if (user_email != "") {
		sgMail.setApiKey(process.env.SENDGRID_API_KEY);
		const msg = {
			to: user_email,
			from: 'hello@ppe-donations.com',
			subject: 'Hospital Contact Information',
			html: str_hosp_info,
		};

		sgMail.send(msg);
	}

}




initDatabase(); 

/* CRITICAL -- Allow cross domain requests */
app.use(allowCrossDomain);

app.get("/", function(req, res) {
  res.send("We're alive and well");
});

app.get("/queryhospitals/", function(req, res) {

  var query = querystring.parse(req.url.split("?")[1]);

  if (query.lat == undefined || query.lon == undefined) {
    res.send(JSON.stringify({
      success: false,
      message: "latitude or longitude missing.",
			hospitals: []
    }));
    return;
  }

	if (!query.n) {
		query.n = "";
	}
	query.n = query.n.replace(/\D/g,'');

  var hospData = processHospitalQuery(query.lat, query.lon, query.n);
  var user_email = query.email;
  console.log("email: " + user_email);
  
  res.send(JSON.stringify({
    success: true,
    hospitals: hospData
  }));

	emailResults(hospData, user_email, query.n);
}); 

app.get("/recentmentions/", function(req, res) {

	var query = querystring.parse(req.url.split("?")[1]);
	if (query.n) {
		query.n = parseInt(query.n)
	}

	var n = (query.n != null && query.n != NaN) ? query.n : 20;

	twitterDB_getRecentMentions(n, function(tweetsJSON) {
		res.send(JSON.stringify(tweetsJSON));
	});

});

app.get("/googleapikey/", function(req, res) {
	res.send(JSON.stringify({
		googleKey:  GOOGLE_API_PUBLIC_KEY
	}));
});

app.listen(port, function() {
  console.log("Server is now listening for requests!");
});

setInterval(pullTwitterMentions, TWITTER_QUERY_DELTATIME * 1000);

/* DO NOT TOUCH, DAVID'S HOMEWORK :-) */
var mongo = require("mongodb").MongoClient;
var mongoURL = "mongodb+srv://rootUser:Patriots%23123@cluster0-jplpr.mongodb.net/test?retryWrites=true&w=majority";
app.get("/companylookup/", function(req, res) {
  var query = querystring.parse(req.url.split("?")[1]);
	var client = new mongo(mongoURL, {useNewUrlParser: true});
	
	var dbQuery = query.queryType == "company" ? {Company: query.company} :
	              query.queryType == "ticker"  ? {Ticker: query.ticker} : {}

	client.connect(mongoURL, function(err, db) {
		if (err) {
			console.log("error connecting to mongo: " + err);
			throw err;
		}
		var mydb = db.db("companiesDB") ;
		mydb.collection("companiesCollection").find(dbQuery).toArray(function(err, result) {
			if (err) {
				console.log("error during DB query: " + err);
				throw err;
			}
			res.send(JSON.stringify(result));
			mydb.close();
		});
	});
});
