var fs = require('fs');
var url = require('url');
var http = require('http');
var https = require('https');
var flash = require('connect-flash');
var express = require('express');
var session = require('express-session');
var morgan = require('morgan');
var passport = require('passport');
var mongoose = require('mongoose');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var LocalStrategy = require('passport-local').Strategy;
var PassportOAuthBearer = require('passport-http-bearer');

var oauthServer = require('./oauth');

var port = (process.env.VCAP_APP_PORT || process.env.PORT ||3000);
var host = (process.env.VCAP_APP_HOST || '0.0.0.0');
var mongo_url = (process.env.MONGO_URL || 'mongodb://localhost/users');

if (process.env.VCAP_SERVICES) {
	var services = JSON.parse(process.env.VCAP_SERVICES);

	for (serviceName in services) {
		if (serviceName.match('^mongo')) {
			var creds = services[serviceName][0]['credentials'];
			mongo_url = creds.url;
		} else {
			console.log("no database found");
		}
	}
}

console.log(mongo_url);
mongoose.connect(mongo_url);

var Account = require('./models/account');
var oauthModels = require('./models/oauth');
var Devices = require('./models/devices');
var Topics = require('./models/topics');

var app_id = 'https://localhost:' + port;

if (process.env.VCAP_APPLICATION) {
	var application = JSON.parse(process.env.VCAP_APPLICATION);

	var app_uri = application['application_uris'][0];

	app_id = 'https://' + app_uri;
}

var cookieSecret = 'ihytsrf334';

var app = express();

app.set('view engine', 'ejs');
app.enable('trust proxy');
app.use(morgan("combined"));
app.use(cookieParser(cookieSecret));
app.use(flash());
app.use(session({
  // genid: function(req) {
  //   return genuuid() // use UUIDs for session IDs
  // },
  secret: cookieSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
  	secure: true
  }
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(passport.initialize());
app.use(passport.session());

function requireHTTPS(req, res, next) {
	if (req.get('X-Forwarded-Proto') === 'http') {
        //FYI this should work for local development as well
        var url = 'https://' + req.get('host');
        if (req.get('host') === 'localhost') {
        	url += ':' + port;
        }
        url  += req.url;
        return res.redirect(url); 
    }
    next();
}

app.use(requireHTTPS);

app.use('/',express.static('static'));

passport.use(new LocalStrategy(Account.authenticate()));

passport.serializeUser(Account.serializeUser());
passport.deserializeUser(Account.deserializeUser());

var accessTokenStrategy = new PassportOAuthBearer(function(token, done) {
	oauthModels.AccessToken.findOne({ token: token }).populate('user').populate('grant').exec(function(error, token) {
		if (token && token.active && token.grant.active && token.user) {
			done(null, token.user, { scope: token.scope });
		} else if (!error) {p
			done(null, false);
		} else {
			done(error);
		}
	});
});

passport.use(accessTokenStrategy);

app.get('/cleanDB', function(req,res){
	Account.remove({});
	Devices.remove({});
	Topics.remove({});
	res.send();
});

app.get('/', function(req,res){
	res.render('pages/index', {user: req.user});
});

app.get('/docs', function(req,res){
	res.render('pages/docs', {user: req.user});
});

app.get('/login', function(req,res){
	res.render('pages/login',{user: req.user});
});

app.get('/logout', function(req,res){
	req.logout();
	res.redirect('/');
});

//app.post('/login',passport.authenticate('local', { failureRedirect: '/login', successRedirect: '/2faCheck', failureFlash: true }));
app.post('/login',
	passport.authenticate('local', { failureRedirect: '/login', failureFlash: true }),
	function(req,res){
		res.redirect('/');
	});

function ensureAuthenticated(req,res,next) {
	if (req.isAuthenticated()) {
    	return next();
	} else {
		res.redirect('/login');
	}
}

app.get('/newuser', function(req,res){
	res.render('pages/register',{user: req.user});
});

app.post('/newuser', function(req,res){
	Account.register(new Account({ username : req.body.username, email: req.body.email, mqttPass: "foo" }), req.body.password, function(err, account) {
		if (err) {
			console.log(err);
			return res.status(400).send(err.message);
		}

		var topics = new Topics({topics: [account.username+'/#']});
		topics.save(function(err){
			if (!err){

				var s = Buffer.from(account.salt, 'hex').toString('base64');
				var h = Buffer.from(account.hash, 'hex').toString(('base64'));

				var mqttPass = "PBKDF2$sha256$901$" + account.salt + "$" + account.hash;

				Account.update(
					{username: account.username}, 
					{$set: {mqttPass: mqttPass, topics: topics._id}}, 
					{ multi: false },
					function(err, count){
						if (err) {
							console.log(err);
						}
					}
				);
			}
		});

		passport.authenticate('local')(req, res, function () {
			console.log("created new user %s", req.body.username);
            res.status(201).send();
        });

	});
});


app.get('/auth/start',oauthServer.authorize(function(applicationID, redirectURI,done){
	oauthModels.Application.findOne({ oauth_id: applicationID }, function(error, application) {
		if (application) {
			var match = false, uri = url.parse(redirectURI || '');
			for (var i = 0; i < application.domains.length; i++) {
				if (uri.host == application.domains[i] || (uri.protocol == application.domains[i] && uri.protocol != 'http' && uri.protocol != 'https')) {
					match = true;
					break;
				}
			}
			if (match && redirectURI && redirectURI.length > 0) {
				done(null, application, redirectURI);
			} else {
				done(new Error("You must supply a redirect_uri that is a domain or url scheme owned by your app."), false);
			}
		} else if (!error) {
			done(new Error("There is no app with the client_id you supplied."), false);
		} else {
			done(error);
		}
   	});
}),function(req,res){
	var scopeMap = {
		// ... display strings for all scope variables ...
		access_devices: 'access you devices',
		create_devices: 'create new devices'
	};

	res.render('pages/oauth', {
		transaction_id: req.oauth2.transactionID,
		currentURL: req.originalUrl,
		response_type: req.query.response_type,
		errors: req.flash('error'),
		scope: req.oauth2.req.scope,
		application: req.oauth2.client,
		user: req.user,
		map: scopeMap
	});
});

app.post('/auth/finish',function(req,res,next) {
	if (req.user) {
		next();
	} else {
		passport.authenticate('local', {
			session: false
		}, function(error,user,info){
			if (user) {
				next();
			} else if (!error){
				req.flash('error', 'Your email or password was incorrect. Try again.');
				res.redirect(req.body['auth_url'])
			}
 		})(req,res,next);
	}
}, oauthServer.decision(function(req,done){
	done(null, { scope: req.oauth2.req.scope });
}));

app.post('/auth/exchange',function(req,res,next){
	var appID = req.body['client_id'];
	var appSecret = req.body['client_secret'];

	oauthModels.Application.findOne({ oauth_id: appID, oauth_secret: appSecret }, function(error, application) {
		if (application) {
			req.appl = application;
			next();
		} else if (!error) {
			error = new Error("There was no application with the Application ID and Secret you provided.");
			next(error);
		} else {
			next(error);
		}
	});
}, oauthServer.token(), oauthServer.errorHandler());

app.get('/api/v1/discover',
	passport.authenticate('bearer', { session: false }),
	function(req,res,next){
		var user = req.user.username;

		Devices.find({username:user}, function(err, data){
			if (!err) {
				console.log(data);
				res.send(data);
			} else {
				res.status(404).send();
			}
		});
	}
);

app.post('/api/v1/command',
	passport.authenticate('bearer', { session: false }),
	function(req,res,next){
		console.log(req.user.username);
		console.log(req.body);
	}
);

app.get('/devices',
	ensureAuthenticated,
	function(req,res){
		var user = req.user.username;

		Devices.find({username:user}, function(err, data){
			if (!err) {
				console.log(data);
				res.render('pages/devices',{user: req.user ,devices: data});
			}
		});
});

app.put('/devices',
	ensureAuthenticated,
	function(req,res){

		var user = req.user.username;
		var device = req.body;

		device.username = user;
		device.isReachable = true;

		var dev = new Devices(device);
		dev.save(function(err, dev){
			if (!err) {
				res.status(201)
				res.send(dev);
			} else {
				res.status(500);
				res.send(err);
			}
		});

});

app.post('/device/:dev_id',
	ensureAuthenticated,
	function(req,res){
		var user = req.user.username;
		var id = req.params.dev_id;
		var device = req.body;
		if (user === device.username) {
			Devices.findOne({_id: device._id, username: device.username},
				function(err, data){
					if (err) {
						res.status(500);
						res.send(err);
					} else {
						data.friendlyDescription = device.friendlyDescription;
						data.actions = device.actions;
						data.save(function(err, d){
							res.status(201);
							res.send(d);
						});
					}
				});
		}
});

app.delete('/device/:dev_id',
	ensureAuthenticated,
	function(req,res){
		var user = req.user.username;
		var id = req.params.dev_id;
		console.log(id);
		Devices.remove({_id: id, username: user},
			function(err) {
				if (err) {
					console.log(err);
					res.status(500);
					res.send(err);
				} else {
					res.status(202);
					res.send();
				}
			});
});

app.post('/api/v1/devices',
	passport.authenticate('bearer', { session: false }),
	function(req,res,next){
		var devices = req.body;
		if (typeof devices == 'object' && Array.isArray(foo)) {
			for (var i=0; i<devices.lenght; i++) {
				var applianceId = devices[i].applianceId;
				Devices.update({
						username: req.user, 
						applianceId: applianceId
					},
					devices[i],
					{
						upsert: true
					},
					function(err){
						//log error
					});
			}
		} else {
			res.error(400);
		}
	}
);

app.get('/api/v1/devices',
	passport.authenticate('bearer', { session: false }),
	function(req,res,next){
		Devices.find({username: req.user.username},function(error, data){
			if (!error) {
				res.send(data);
			}	
		});
	}
);

app.get('/services',
	ensureAuthenticated, 
	function(req,res){
		if (req.user.username == 'hardillb') {
			oauthModels.Application.find({}, function(error, data){
				if (!error){
					res.render('pages/services',{user:req.user, services: data});
				}
			});
		} else {
			res.redirect('/');
		}
});

app.put('/services',
	ensureAuthenticated,
	function(req,res){
		if (req.user.username == 'hardillb') {
			
			var application = oauthModels.Application(req.body);
			application.save(function(err, application){
				if (!err) {
					res.status(201).send(application);
				}
			});
		} else {
			res.status(401).send();
		}
});

app.post('/service/:id',
	ensureAuthenticated,
	function(req,res){
		var service = req.body;
		oauthModels.Application.findOne({_id: req.params.id},
			function(err,data){
				if (err) {
						res.status(500);
						res.send(err);
					} else {
						data.title = service.title;
						data.oauth_secret = service.oauth_secret;
						data.domains = service.domains;
						data.save(function(err, d){
							res.status(201);
							res.send(d);
						});
					}
			});
});

app.delete('/service/:id',
	ensureAuthenticated,
	function(req,res){
		oauthModels.Application.remove({_id:req.params.id},
			function(err){
				if (!err) {
					res.status(200).send();
				} else {
					res.status(500).send();
				}
			});
});

//Work around for not being able to access Mongo from container
app.post('/mqtt/auth',function(req,res){
	var username = req.body.username;
	var password = req.body.password;
	var topic = req.body.topic;
	var acc = req.body.acc;

	passport.authenticate('local',function(err,user,info){
		if (!err && user) {
			return res.status(200).send();
		} else {
			return res.status(401).send();
		}
	})(req, res, function () {
		
    });
});

app.post('/mqtt/acl',function(req,res){
	var username = req.body.username;
	var clientid = req.body.clientid;
	var topic = req.body.topic;
	var acc = req.body.acc;

	if (topic.indexOf(username+'/') === 0) {
		res.status(200).send();
	} else {
		res.status(401).send();
	}
});

app.post('/mqtt/superuser',function(req,res){
	var username = req.body.username;
	if (username === 'hardillb') {
		res.status(200).send();
	} else {
		res.status(401).send();
	}
});

var server = http.Server(app);
if (app_id.match(/^https:\/\/localhost:/)) {
	var options = {
		key: fs.readFileSync('server.key'),
		cert: fs.readFileSync('server.crt')
	};
	server = https.createServer(options, app);
} 


server.listen(port, host, function(){
	console.log('App listening on  %s:%d!', host, port);
	console.log("App_ID -> %s", app_id);
});