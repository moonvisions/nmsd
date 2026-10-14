FESTIVAL TYCOON - ONLINE SERVER (one-time setup, about 15 minutes, free)

This small program lets friends anywhere join your festival with a 5-letter room code.
You set it up once. After that, it just runs.

WHAT YOU NEED
- A free GitHub account (github.com)
- A free Render account (render.com). You can sign up with your GitHub account.

STEP 1 - PUT THESE FILES ON GITHUB
 1. Go to github.com and sign in.
 2. Click the + at the top right, then "New repository".
 3. Name it:  festival-tycoon-relay
 4. Choose "Public". Click "Create repository".
 5. On the next page click the link "uploading an existing file".
 6. Drag in these files from this folder:  package.json  relay.js  payments.js  community.js
    leaderboards.js  store.js  storeverify.js  reports.js  patchbay.js  worlds.js  applications.js
    and vendors.json   (Round 69: storeverify.js checks Steam / Google Play / App Store purchases -
    see STORE_PURCHASES_SETUP.txt)
    (NOT the node_modules folder, and NEVER tickets.json - codes are secret)
 7. Click the green "Commit changes" button.

STEP 2 - START IT ON RENDER
 1. Go to render.com and click "Get Started". Sign up with GitHub.
 2. Click "New +" (top right), then "Web Service".
 3. Pick "festival-tycoon-relay" from the list (click "Connect").
 4. Fill in:
      Name:           festival-tycoon-relay
      Runtime:        Node
      Build Command:  npm install
      Start Command:  npm start
      Instance Type:  Free
 5. Click "Create Web Service". Wait until it says "Live" (2-5 minutes).
 6. At the top of the page there is an address like:
      https://festival-tycoon-relay.onrender.com
    Click the copy button next to it.

STEP 3 - TELL THE GAME
 1. In the game, open Settings.
 2. Under "Play with friends", press "Paste server address".
 3. Done! Now "Host online" gives you an invite like ABCDE@festival-tycoon-relay.onrender.com
    (it is copied for you). Send it to friends; they press "Paste invite and join".

GOOD TO KNOW
- The free server goes to sleep after 15 minutes with nobody on it. The next time someone
  hosts, it takes up to a minute to wake up. That's normal.
- Friends do NOT need to set anything up: the invite includes the server.


VENDOR VILLAGE - ADDING REAL VENDORS (Round 33)
The booths in the game come from the file vendors.json on this server. To add, change or remove
a vendor, you just edit that file on GitHub. No new version of the game is needed.

 1. On github.com open your festival-tycoon-relay repository and click vendors.json.
 2. Click the pencil (Edit) button.
 3. Copy one whole vendor block (from { "id": ... to its closing } ) and paste it after the last
    one, with a comma between them. Change the words:
      id        a short name with no spaces, like  lunas-wire-wraps
      name      what the booth sign says
      tagline   one short line about what they make
      store     their shop link, starting with https://   (or "" for none)
      social    their Instagram or similar, starting with https://   (or leave it out)
      colour    the booth colour, like "#7a3cff"  (google "color picker" to find one)
      items     what they sell. Each item has:
                  id       short, no spaces
                  name     what players see
                  kind     one of: tee hoodie cap bucket bandana glasses pendant bracelet backpack totem
                  colour   main colour;  accent  second colour (print, gem, band...)
                  price    festival tokens for the in-game version (40-120 is about right)
                  link     the real item's page, starting with https:// (optional)
                  pattern  the design (optional): plain tiedye stripes spiral checker dots split
                  print    a word or two printed on the chest of a tee or hoodie (optional, 16 letters max)
    TIP: vendors can design their items with the Merch Designer page and send you the finished
    block - you just paste it in.
 4. Click "Commit changes". Render restarts the server in a minute or two.
 5. Players get the new booths the next time they open the game (online).

 - Delete the three "(sample)" vendors once you have real ones.
 - Up to 24 vendors and 12 items each. The biggest sites show 8 booths at a time.
 - Only https:// links are opened; anything else is ignored.
 - Check your file: paste it into jsonlint.com - it must say "Valid JSON".
 - Real purchases happen on the vendor's own site. The game never takes payments.


DANCE BATTLE ARENA - ARTISTS' MUSIC (Round 38)
Battles at the arena play artists' own royalty-free tracks, with a "Listen to the artist" button
after every battle. Tracks live in the same vendors.json file, in the "tracks" list at the bottom.

 1. Edit vendors.json on GitHub (same as for vendors).
 2. Inside  "tracks": [ ]  add one block per song, with commas between blocks:
      { "id": "sunrise-anthem", "title": "Sunrise Anthem", "artist": "DJ Example",
        "url": "https://example.com/music/sunrise-anthem.mp3", "bpm": 124, "offset": 0.0,
        "link": "https://soundcloud.com/dj-example" }
      id      short, no spaces
      title   the song's name;  artist  who made it
      url     a direct link to the audio file itself, ending in .mp3, .ogg or .wav, starting with https://
              (a Dropbox link works if you change the end from ?dl=0 to ?dl=1 - but it must end in .mp3,
              so a web host or GitHub itself is easier: upload the mp3 to the same GitHub repository and use
              its "raw" link)
      bpm     the song's beats per minute (the artist will know it; or search "bpm finder")
      offset  seconds from the start of the file to the first beat (0 if it starts on the beat)
      link    where players can listen to or buy their music
 3. Commit. Players get it the next time they open the game online.

 - Only use music the artist owns and has agreed to share. Up to 40 tracks.
 - If a track can't be downloaded, the arena plays one of its built-in mixes instead.


SPECIAL FEATURES ARE OFF UNTIL YOU SWITCH THEM ON (Round 43)
Near the top of vendors.json:   "features": { "artistVenues": false, "ticketSales": false }
 - artistVenues  true = artists' venues appear at every festival (live streams, ticket gates)
 - ticketSales   true = real-money tickets through Stripe (needs the Stripe setup below)
Leave them false and the game stays the festival tycoon career plus the multiplayer festival.
Your admin page (https://YOUR-SERVER.onrender.com/admin, then your ADMIN_KEY password) shows what's on.

ARTISTS' VENUES - LIVE SETS (Round 42)
An artist can have their own venue at every festival: a fenced stage with a big screen and a ticket
gate. Players pay the entry in festival tokens, or enter a real ticket code, and inside they hear
(and see) the artist's live stream.

 1. Edit vendors.json on GitHub. Inside  "venues": [ ]  add one block per artist:
      { "id": "dj-example", "name": "THE BASEMENT", "artist": "DJ Example",
        "stream": "https://stream.example.com:8443/live.mp3", "live": true,
        "schedule": "Fridays 9pm ET", "price": 30,
        "ticketUrl": "https://buy.stripe.com/your-link", "link": "https://soundcloud.com/dj-example",
        "colour": "#ff4f93" }
      stream     the artist's live stream link, starting with https:// . An internet-radio (Icecast)
                 .mp3/.ogg/.aac stream is the most reliable; .mp4 or HLS .m3u8 video also work on most devices.
                 DJs can stream from their mixing software (Mixxx, Traktor, Serato via BUTT) to an Icecast
                 host such as Radio.co, Caster.fm or their own Icecast server.
      live       true while they're streaming (switch it on and off here), false otherwise
      price      festival tokens to get in (0 = free)
      ticketUrl  (optional) where fans buy a real ticket; every ticket buyer gets a code
      link       the artist's page
 2. Ticket codes are SECRET, so they never go on GitHub (the repository is public).
    On render.com open your service > Environment > Secret Files > Add Secret File:
      Filename:  tickets.json
      Contents:  { "dj-example": ["K7QX-M2PA-9TRD", "B4HN-ZW8C-3LFE"] }
    (tickets.example.json shows the layout.) Use long random codes - one per buyer.
    A code opens the door on up to 2 devices, and the same device can come back any time.
    Changes to the secret file are picked up within a minute of saving.
    (Tickets sold through Stripe - below - make their own codes, so you don't list those here.)
 3. Make sure "artistVenues" is true in the "features" line at the top of vendors.json.
 4. Commit. Players get the venue the next time they open the game online.


PLAYERS' OWN CREATIONS - THE COMMUNITY PLAZA (Round 45)
Players design their own attractions in the game (Build > Attractions > CREATE YOUR OWN) and can
press "Send to community". Nothing goes public by itself - you approve each one first.

Already running your server from an earlier round? Update it once:
1. On GitHub, open your festival-tycoon-relay repository.
2. Click "Add file" > "Upload files".
3. Drag in community.js, relay.js and payments.js from this folder (it replaces the old ones).
4. Click "Commit changes". Render restarts the server by itself in a minute or two.

To look at what's been sent:
1. You need an admin password set. On Render: your service > Environment > Add Environment Variable.
   Key: ADMIN_KEY   Value: a password you make up (at least 8 letters). Save. (Skip if you did this already.)
2. Open https://YOUR-SERVER.onrender.com/admin in your browser and type that password.
3. Scroll to "Community creations". Each one shows its name, who made it and two little pictures
   (from the front and from above).
4. Press Approve to put it up, or Reject to throw it away. Approved ones appear on the Community
   Plaza at everyone's festival within about 10 minutes. "Take down" removes one again.

Keeping them for good (important on a free server):
A free Render server forgets its files whenever it restarts from GitHub. After approving, the admin
page shows a line that starts with "creations": [ ... ].
1. Copy that whole line.
2. On GitHub, open vendors.json and press the pencil (edit).
3. Click just after the very first {  at the top, press Enter, and paste the line.
4. Press "Commit changes". Those creations now stay forever.

Players can also share creations with no server at all: "Share code" in the studio copies a short
code (starting FTC1-) they can send to a friend, who pastes it with "Paste a code".

LIVE EVENTS - A REAL ARTIST, LIVE, AT A WHOLE ONLINE FESTIVAL (Round 50)
You host the festival from your game; the artist streams their set (and camera) from home; fans buy a
ticket, join, and walk the field together - chat, skate, lawn games, dance - while the set plays on the
main stage and every LED screen. Up to 32 fans per event (everyone goes through your game).

1. Switch it on. In vendors.json change the features line to include  "liveEvents": true
   e.g.  "features": { "artistVenues": false, "ticketSales": true, "liveEvents": true },
2. Add the event. In vendors.json add (after the features line):
     "events": [
       { "id": "moonrise", "name": "Moonrise Live", "artist": "DJ Example",
         "stream": "https://the-artist-stream-link.m3u8",
         "when": "Saturday 9pm ET", "ticketPrice": 10.00 }
     ],
   - "id": one short word, no spaces. It's in the ticket codes, so never change it once tickets are sold.
   - "stream": the artist's live link (a video .m3u8 or .mp4 shows their camera on the screens;
     an audio stream link works too). Ask the artist for it before the night.
   - For a free event use  "free": true  instead of ticketPrice.
   - To pay the artist their share automatically, add their  "stripeAccount": "acct_..."  (get it the
     same way as for a venue: admin page > Set up payouts). Leave it out and all the money is yours.
   Commit the change.
3. Set an event password on Render: your service > Environment > Add Environment Variable.
   Key: EVENT_HOST_KEY   Value: a password (8+ letters, different from your admin password). Events can't open without it.
4. On the night, open the game, go to Settings, find LIVE EVENTS, open "I'm the organiser" under your
   event, type the event password and press "Open this event". Keep the game open for the whole set.
5. Fans: Settings > LIVE EVENTS > "Buy a ticket" (Stripe checkout; they get a code on screen and on
   their emailed receipt), type the code, press "Join now". A LIVE NOW banner shows in everyone's game.
   Each code works on up to 2 devices. You can also hand out free codes: add them to your secret
   tickets.json under the event id, e.g.  { "moonrise": ["GUEST-LIST-0001"] }

SELLING REAL TICKETS WITH STRIPE (Round 43)
Fans pay on Stripe's secure checkout page (card, Apple Pay / Google Pay, and USDC crypto if you switch
it on). The artist gets paid into their own bank account; your fee (10%) is kept automatically.
The thank-you page shows a ticket code that opens the venue's gate in the game. No database needed.
I'm not a lawyer or accountant - Stripe handles ID checks and tax forms, but read their terms.

A. MAKE YOUR STRIPE ACCOUNT (one time, about 15 minutes)
 1. Go to stripe.com and click "Start now". Sign up with your business email and details.
 2. At the top right, make sure "Test mode" is ON while you practise (you'll switch it off later).
 3. In the left menu click "Connect" (or search "Connect" at the top), then "Get started".
    When asked, choose "Platform or marketplace" and "Express" accounts for your artists.
 4. Optional, for crypto: Settings (gear icon) > Payments > Payment methods > find "Crypto" or
    "Stablecoins" and switch it on (only shows if it's offered in your country).
 5. Click "Developers" > "API keys". Next to "Secret key" click "Reveal" and copy it
    (it starts with sk_test_ in test mode).

B. TELL YOUR SERVER (Render)
 1. On render.com open your festival-tycoon-relay service > "Environment" > "Add Environment Variable".
 2. Add these three, then click "Save Changes" (the server restarts itself):
      STRIPE_SECRET_KEY   the key you copied (sk_test_...)
      TICKET_SECRET       a long random password you make up (e.g. 30 random letters and numbers).
                          Keep it forever - changing it cancels every ticket already sold.
      ADMIN_KEY           another password, for your admin page (at least 8 characters)
      PUBLIC_URL          your server's address, e.g. https://festival-tycoon-relay.onrender.com
    Optional: PLATFORM_FEE_PERCENT = 10  (your fee; 10 if you leave it out)
 3. Also upload the new server files to GitHub (payments.js is new; relay.js, package.json and
    README.txt changed), same as before.

C. SIGN AN ARTIST UP
 1. Open  https://YOUR-SERVER.onrender.com/admin  in your web browser and type your ADMIN_KEY password.
 2. Next to the artist's venue click "Set up payouts". Send the link it shows to the artist -
    they enter their details and bank account with Stripe (about 5 minutes). The link keeps
    working, so they can come back to it later.
 3. The page also shows a line like  "stripeAccount": "acct_1ABC...", "ticketPrice": 5.00
    Add it to that venue in vendors.json on GitHub (inside the venue's { }), set the price the
    artist wants in US dollars, and commit.
 4. Switch "ticketSales" to true in the "features" line at the top of vendors.json and commit.
 5. That's it: the venue's gate in the game now shows "Buy a ticket $5.00".

D. PRACTISE, THEN GO LIVE
 1. In test mode, buy a ticket in the game and pay with card number 4242 4242 4242 4242,
    any future date, any 3 numbers. The thank-you page shows a code - type it at the gate.
 2. When it all works: in Stripe switch "Test mode" OFF, copy the live secret key (sk_live_...),
    put it in STRIPE_SECRET_KEY on Render, and sign each artist up again with a live link
    (test and live accounts are separate).

GOOD TO KNOW
 - Refunds and disputes: you can refund a fan from your Stripe dashboard (Payments > the payment >
   Refund). As the platform you're responsible for handling these fairly with your artists.
 - Your cut of each ticket is your fee (10%) plus Stripe's card fee (2.9% + 30 cents), because Stripe
   charges that card fee to you, the platform. On a $5.00 ticket you keep about $0.95 and the artist gets
   about $4.05. Your admin page shows the numbers. Tickets must be at least $2.00.
 - Stripe emails each buyer a receipt with their ticket code on it. Check it's on:
   Stripe > Settings > Customer emails > "Successful payments".
 - Only sell tickets through the desktop/web game or a web page - inside the iPhone/Android apps the
   store rules on digital purchases apply (the gate there should only accept codes).


FESTIVALS LIST AND VOICE CHAT (Round 54)
Two new things, both inside relay.js. Nothing to switch on and no new settings on Render.

HOW TO UPDATE YOUR SERVER (about 3 minutes)
 1. On github.com open your festival-tycoon-relay repository.
 2. Click relay.js, then the pencil (Edit) button. Select everything in it and delete it.
 3. Open the new relay.js from this folder in Notepad (or TextEdit), select everything, copy it,
    and paste it into GitHub.
 4. Click the green "Commit changes" button. Render restarts the server in a minute or two.
 5. Also do the same for this README.txt if you keep it on GitHub (it isn't needed to run).
 To check it worked: open  https://YOUR-SERVER.onrender.com/rooms  in your web browser.
 It should show something like  {"ok":true,"now":...,"rooms":[]}

THE FESTIVALS LIST (like a streaming site's directory)
 - In the game: title screen > "Festivals online", or Settings > "Browse festivals online", or F7.
 - Every room is PRIVATE (invite only) unless its host switches on "Go public"
   (Settings > Play with friends, after pressing Host online). Then the festival shows in
   everyone's list with its name, a short note, the act on now, the line-up, who's there, and
   a countdown if the host set one. Anyone can press JOIN.
 - Live events (the ticketed ones) are listed by themselves while they're open. JOIN asks
   for the ticket code, exactly as before - their room code is never shown.
 - A listing disappears by itself if the host's game stops updating it (about 90 seconds),
   and at once when they switch back to Private or close the room.
 - The list is also at  https://YOUR-SERVER.onrender.com/rooms  (anyone asking too often -
   more than 30 times a minute - is told to wait).

PROXIMITY VOICE CHAT
 - Players who switched their microphone on (Settings > Voice chat) can talk to people standing
   near them (about 20 metres). The server only passes each little piece of sound straight on to
   the players near the speaker. It is NEVER recorded, saved or looked at.
 - Limits built in: a piece of sound can't be bigger than 1600 letters, and each player can send
   at most 30 a second (normal talking is about 17). Anything over is simply dropped.
 - Bandwidth: about 11 KB a second for each person talking, only while they talk.


MOON SHARDS STORE, PLAYER ACCOUNTS AND THE VENDOR MARKET (Round 55)
This is how the game makes money from outfits, the GTA Online way: one store currency, a few
hand-picked vendors, and nothing appears in the game unless YOU approve it.

WHAT PLAYERS SEE
 - "Moon Shards" - the game's one premium currency. Players buy packs on the web or PC game through
   Stripe's secure checkout. Festival tokens (earned by playing) stay exactly as they were and can't be
   bought or turned into shards.
 - A free account (Settings > Account & Store: a display name + email). Their shards and everything
   they buy live on YOUR server, so it follows them to any device. They get a recovery code ONCE - that
   code signs them in on another device. The game never decides balances; the server does.
 - The Store screen (Outfit Studio > STORE, or Settings > Account & Store > Open the Store):
   buy shards, premium looks (the festival's own pieces: a moon crown, astro helmet, moth wings, galaxy
   and aurora prints...), and VENDOR DESIGNS.
 - Outfit Studio (O) has two new tabs, Premium and Vendor designs - try anything on first, buy to keep.
   Everyone at a festival sees what you wear (it travels with the outfit, even to friends whose game
   hasn't downloaded the newest vendor list yet).
 - Vendor-market booths in the Vendor Village sell the approved designs for shards. Every design has a
   Report button - reports land on your admin page.

WHAT VENDORS DO
 - They go to  https://YOUR-SERVER.onrender.com/vendor  and apply (shop name, email, link, a password).
 - You approve them on your admin page. Then they sign in there and pay for a SEASON PLAN:
      Starter stall   3 designs   $49 a season
      Market stall    6 designs   $89 a season
      Flagship booth 12 designs  $149 a season
   (A season is 3 months: Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec. Buying in the last 3 weeks of a season
   also covers the next one.)
 - They send designs: what it is (tee, hoodie, cap, bucket hat, bandana, glasses, pendant, bracelet,
   backpack, totem), two colours, a pattern, a few printed words and a price (200-800 shards). Or they
   paste a "look code" from the game (Outfit Studio > Saved > Copy my look code).
 - Every design waits in YOUR review queue. A rude-word/drug-word filter stops the obvious stuff first.
 - They earn 50% of each sale (1 shard is about 1 cent). Your admin page shows what you owe each vendor.
   Pay them yourself (bank transfer, PayPal...) then press "I paid".
 - Limits: their plan's number of slots (live + waiting), 10 designs sent a day, 3 applications a day
   from one place. If their plan ends, their designs go off sale (players keep what they bought).

ONE-TIME SETUP (about 30 minutes)
IMPORTANT: a free Render server FORGETS its files every time it restarts. Players' shards must never be
forgotten, so the store stays shut until you give it a permanent disk.

 A. Upload the new server files to GitHub (store.js is new; payments.js, community.js and README.txt
    changed): open your festival-tycoon-relay repository > "Add file" > "Upload files" > drag them in >
    "Commit changes".

 B. Give the server a permanent disk (this needs Render's paid "Starter" instance, about $7 a month,
    plus about 25 cents a month for a 1 GB disk):
    1. render.com > your service > "Settings" > Instance Type > choose "Starter" > Save.
    2. Left menu > "Disks" > "Add Disk".  Name: store-data   Mount Path: /var/data   Size: 1 GB > Save.
    3. Left menu > "Environment" > "Add Environment Variable":
         Key: STORE_DATA_DIR     Value: /var/data
       Save. (The server restarts by itself.)

 C. Tell Stripe where to send "payment confirmed" messages (so shards are added automatically):
    1. stripe.com > Developers > Webhooks > "Add endpoint" (or "Add destination").
    2. Endpoint URL:  https://YOUR-SERVER.onrender.com/store/webhook
    3. Events to send - tick these four:
         checkout.session.completed
         checkout.session.async_payment_succeeded
         checkout.session.expired
         charge.refunded
    4. Save, then on the endpoint's page click "Reveal" under "Signing secret" and copy it (whsec_...).
    5. Render > your service > Environment > Add Environment Variable:
         Key: STRIPE_WEBHOOK_SECRET    Value: the whsec_... you copied
    You do NOT need to make "products" in Stripe - the server tells Stripe the pack and price itself.
    You also need STRIPE_SECRET_KEY, PUBLIC_URL and ADMIN_KEY set (see "SELLING REAL TICKETS" above).
    Optional: VENDOR_SHARE_PERCENT (the vendor's share of each sale, 50 if you leave it out).

 D. Switch it on. In vendors.json on GitHub, add two words to the "features" line, e.g.
      "features": { "artistVenues": false, "ticketSales": false, "store": true, "vendorPortal": true },
    and commit. ("store" = shards and accounts; "vendorPortal" = vendors can apply.)

 E. Check it. Open https://YOUR-SERVER.onrender.com/admin > your password. The "Moon Shards store"
    table should say "ready" on every line.

 F. Practise in Stripe TEST mode: in the game, Settings > Account & Store > make an account > Open the
    Store > MOON SHARDS > buy a pack with card 4242 4242 4242 4242 (any future date, any 3 numbers).
    Come back to the game - the shards arrive by themselves within a minute. When all is well, switch
    Stripe to live mode, put the live sk_live_ key in STRIPE_SECRET_KEY, and make a live webhook (step C
    again in live mode - it has its own whsec_ secret).

YOUR ADMIN PAGE (https://YOUR-SERVER.onrender.com/admin)
 - Reports from players: "It's fine - dismiss", "Take the design down", or "Ban the vendor".
 - Designs waiting for you: a little picture of each, Approve or Reject (you can say why - the vendor
   sees it). Approved designs appear in everyone's game within about 10 minutes.
 - Vendor applications: Approve / Reject. Email approved vendors so they know to choose a plan.
 - Live designs: Take down any time.
 - Vendors: their plan, slots, what you owe them, "I paid", Ban / Unban.
 - Help a player: give shards (or take them back with a minus) - the player's account id is shown in
   their game under Settings > Account & Store. "Suspend / restore account" stops an account shopping.
 - Download a backup: do this now and then and keep the file somewhere safe.

GOOD TO KNOW
 - PHONE APPS: Apple and Google require their own in-app purchases for digital items sold inside iPhone
   and Android apps. The phone builds therefore hide all shard buying (and spending) and show
   "coming soon". Players still see and wear everything their account owns. Never put a Stripe link in
   the phone apps. (A programmer can later plug App Store / Google Play billing in - see CreditStore.cs.)
 - Refunds: refund in Stripe (Payments > the payment > Refund). The server takes those shards back
   automatically; if they were already spent, the account is marked on your admin page.
 - Changing prices: the packs, premium prices and vendor plans are near the top of store.js
   (cents = US cents). Change, commit, done.
 - Files on the disk: store-data.json (everything), store-data.bak.json (the version before),
   store-ledger.jsonl (every shard movement ever, one line each - your audit trail).
 - Players' rules page: https://YOUR-SERVER.onrender.com/store/terms (no cash value, no cashing out,
   curated designs). I'm not a lawyer or accountant: check sales tax (Stripe Tax can do it), your refund
   policy and a simple vendor agreement before going live.
 - Testing on your own computer only: STORE_ALLOW_LOCAL_FILES=1 keeps the files next to store.js.


PUBLIC ROOMS - KEEPING THEM FRIENDLY (Round 57)
Players can report someone in an online room (in the game: Settings > People here > Report).
 - Reports show on your admin page (https://your-server.onrender.com/admin) under
   "Player reports from online rooms". Press "Seen - clear" when you've looked.
 - When 3 different people report the same player in a room, the server acts by itself: a guest is
   removed from that room (and can't come back into it); a host's room is taken off the public list.
   To change the 3: add REPORTS_TO_ACT on Render (Environment), e.g. 4.
 - A host can also remove anyone from their own room (Settings > People here > Remove).
 - Limits that keep the free server healthy (you don't need to change them): each player's messages
   are rate-limited, one network can keep 4 rooms open (ROOMS_PER_IP) and 40 connections
   (SOCKETS_PER_IP), and wrong room codes are slowed down.


BIG NIGHT PASSES - BIGGER, FEATURED ROOMS FOR ONE NIGHT (Round 58)
What players get:
 - Normal online rooms stay FREE, always: the host + up to 16 other players.
 - A "Big Night" pass (you choose the price - $3.99 is the plan) turns ONE of a player's online rooms
   into a Big Night: up to 100 people, for 6 hours from the moment they open it, and the room is
   FEATURED - first in everyone's Festivals list with a gold "BIG NIGHT" badge.
 - The 6 hours keep running even if they close the room, and they can reopen it inside those hours
   without using another pass. When the time is up the room carries on as a normal room - nobody is
   thrown out; new people just can't join until it's under 17 again.
 - Passes live on the player's free account (Settings > Account & Store), so they work on any device.
   Unused passes never expire. One pass = one Big Night. Not a subscription.
 - Players can also buy a pass with Moon Shards (400 unless you change it).
 - The phone apps never sell passes (Apple/Google rules) - a pass bought on PC or web works there too.
 - Real ticketed live events are separate and unchanged (still your 10% fee through Stripe).
The server decides every room's size, so nobody can make their own room bigger by changing the game.

BEFORE YOU START: the Moon Shards store must already be set up (see "MOON SHARDS STORE" above:
the permanent disk, STORE_DATA_DIR, "store": true in vendors.json, STRIPE_SECRET_KEY,
STRIPE_WEBHOOK_SECRET, PUBLIC_URL and ADMIN_KEY). Passes are kept in the same safe file as shards.

STEP 1 - UPLOAD THE NEW SERVER FILES (about 3 minutes)
 1. Go to github.com and open your festival-tycoon-relay repository.
 2. Click "Add file" (top right), then "Upload files".
 3. Drag in these files from this folder:  relay.js  store.js  README.txt
    (relay.js and store.js changed. The other files did not change this time. NEVER upload tickets.json
    or the node_modules folder.)
 4. Click the green "Commit changes" button. Render restarts the server by itself in a minute or two.
 Until you do Step 2, nothing is sold - the game just says "Big Night passes aren't on sale yet".

STEP 2 - MAKE THE PASS IN STRIPE (TEST MODE FIRST, about 5 minutes)
 1. Go to stripe.com and sign in. At the top right, switch "Test mode" ON.
 2. In the left menu click "Product catalog", then "+ Add product" (or "Create product").
 3. Fill in:
      Name:         Big Night pass
      Description:  One bigger, featured online room for 6 hours in New Moon, Same Dark
      Pricing:      choose "One-off" (NOT "Recurring")
      Amount:       3.99   Currency: USD
    Click "Add product" (or "Save").
 4. You're now on the product's page. Under "Pricing" you see the $3.99 price. Click the "..." next to
    it and choose "Copy price ID" (or click the price and copy the ID at the top). It starts with price_
 5. Go to render.com > your festival-tycoon-relay service > "Environment" > "Add Environment Variable":
      Key:    BIGNIGHT_PRICE_ID
      Value:  the price_... you copied
    Click "Save Changes". The server restarts by itself.
 6. Webhook: nothing new to do. The same Stripe webhook you made for Moon Shards (the four events
    checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.expired and
    charge.refunded) also delivers passes and refunds.

STEP 3 - CHECK IT ON YOUR ADMIN PAGE
 1. Open https://YOUR-SERVER.onrender.com/admin in your web browser and type your ADMIN_KEY password.
 2. At the top you'll see "Big Night passes". Check:
      Mode:                     PAID - passes on sale
      Stripe Price:             ready  $3.99 one-time
      On sale in the game now:  yes (card)  yes (shards)
    If the Stripe Price line says "checking with Stripe...", reload the page after a few seconds. If it
    says "subscription", go back to Step 2 and make a One-off price instead.

STEP 4 - PRACTISE WITH STRIPE TEST MODE (about 10 minutes, on the PC or web game)
 1. In the game: Settings > Account & Store. Make an account if you don't have one.
 2. Press "Open the Store", then the "BIG NIGHT" tab. Press "Buy a pass - $3.99".
 3. Stripe's checkout opens in your web browser. Pay with the TEST card:
      card number 4242 4242 4242 4242, any future date (like 12/34), any 3 numbers, any name/zip.
 4. Go back to the game. Within about a minute a "BIG NIGHT PASS READY" message pops up, and the
    BIG NIGHT tab says "1 Big Night pass". (Press Refresh in the Store if you're impatient.)
 5. Host it: Settings > Play with friends > HOST ONLINE > the gold "Big Night" card >
    "Host a Big Night (uses 1 pass)". (Or press F7 for the Festivals list > "+ Host a festival".)
    You'll see "Your Big Night has started!" and a gold timer in Settings. Switch on "Go public".
 6. Check the list: open https://YOUR-SERVER.onrender.com/rooms in your web browser. Your room says
    "featured":true and "capacity":100. In the game, press F7: your room is first with the gold badge.
 7. Check the admin page: "Running now" shows your account and room code.
 8. Try a refund: in Stripe (still test mode) click "Payments", click the $3.99 payment, "Refund".
    Within about 30 seconds the game says the Big Night ended and the room is a normal room again,
    and the admin page shows "1 refunded".
 9. Try shards too: admin page > "Help a player" > give yourself 400 shards (your account id is in the
    game under Settings > Account & Store), then in the Store's BIG NIGHT tab press "Buy with 400 Moon Shards".

STEP 5 - GO LIVE (real money)
 Stripe keeps test and live products separate, so:
 1. In Stripe switch "Test mode" OFF and make the same "Big Night pass" product again (Step 2, One-off, 3.99).
 2. Copy the LIVE price ID (price_...) and put it in BIGNIGHT_PRICE_ID on Render.
 3. You should already have your live sk_live_ key in STRIPE_SECRET_KEY and a live webhook secret in
    STRIPE_WEBHOOK_SECRET (from the Moon Shards setup). Save. Check the admin page says "ready".

SWITCHES (all optional - Render > Environment, or the admin page)
 - Pause sales for a while: admin page > "Pause sales" (press again to resume). Passes people already
   bought keep working.
 - BIGNIGHT_MODE = off     no new passes are sold (ones already bought still work).
 - BIGNIGHT_MODE = free    big rooms are FREE for everyone, no pass needed (a launch party, say).
                           Delete it (or set paid) to go back to normal.
 - BIGNIGHT_SHARDS = 400   the price in Moon Shards (0 = passes can't be bought with shards).
 - BIGNIGHT_SIZE = 100     how many people a Big Night room holds (20 to 200).
 - BIGNIGHT_HOURS = 6      how long a pass lasts once it's opened.
 - Changing the money price: make a new One-off price on the same Stripe product, then put its new
   price_... in BIGNIGHT_PRICE_ID. (The game always shows Stripe's real price.)
 - Admin page buttons: "Give 1 Big Night pass" (to say sorry, or for a giveaway) and
   "End their running Big Night now" (for abuse; to give money back, refund in Stripe instead).

IMPORTANT - SERVER TRAFFIC (please read before you promote it)
 A busy room sends a lot of little "where everyone is" messages through YOUR server, and hosting
 companies charge for traffic over your plan's allowance. The game already saves a lot (people only
 get every step from the ~24 players nearest them, and everyone else's every 2 seconds), but a FULL
 100-person room for all 6 hours could still move very roughly 100-170 GB. A 30-person night is more
 like 15-20 GB, a 50-person night 40-70 GB. Most nights won't be full or last the whole 6 hours.
 1. After your first few Big Nights, look at Render > your service > "Metrics" > "Bandwidth".
 2. Compare it with Render's current price for extra bandwidth on your plan.
 3. If it costs too much, set BIGNIGHT_SIZE = 50 (or raise the price) - no game update needed.
 Also: the HOST's own internet does the most work (every player goes through their game). A 100-person
 room needs roughly 5 Mbps of UPLOAD speed on the host's connection - a normal home connection is fine
 for 30-50 people; for 100, the host should be on a good wired connection.



LIVE MODE - PATCHING REAL DJs ONTO THE STAGES (Round 60)
Your server now has a "DJ Patch Bay": a web page where you keep a list of real DJs and "patch" each one
onto a stage of an online festival, like plugging a cable into a mixing desk. Everyone in that festival
(the host AND every guest) then hears the DJ's live stream from that stage's speakers - and sees their
video on that stage's screens if they stream video. People who arrive later join in at the same moment.
The stages: Main Stage, Second Stage, Third Stage, Pop-up Tent, Artist Venue. If a festival doesn't have
one of them (no third stage, say), that DJ plays on a free stage it does have.

WHAT CHANGED ON THE SERVER (upload these once)
 1. Go to github.com and open your festival-tycoon-relay repository.
 2. Click "Add file" (top right), then "Upload files".
 3. Drag in these files from this folder:  patchbay.js (new)  relay.js  payments.js  README.txt
    and .gitignore if you can see it (some computers hide files starting with a dot - then skip it).
    (NEVER upload patchbay-data.json - it holds your DJs' private links - or tickets.json or node_modules.)
 4. Click the green "Commit changes" button. Render restarts the server by itself in a minute or two.
 Render settings you need (render.com > your service > "Environment"):
    ADMIN_KEY        your admin password (you already have it if you use /admin). The patch bay uses it too.
    EVENT_HOST_KEY   only if you run ticketed LIVE EVENTS (the organiser's password for opening one).
    PUBLIC_URL       optional: your server's address, so the DJs' private links show it (Render's own
                     address is used if you leave it out).
    STORE_DATA_DIR   optional: if you gave the server a permanent disk (see the Moon Shards section), the
                     patch bay is kept there too and survives restarts. Nothing else to do.
 Nothing else is needed: no new game version, no new database.

STEP 1 - OPEN THE PATCH BAY
 1. In your web browser go to  https://YOUR-SERVER.onrender.com/admin/patch
    (or open your normal admin page and press "Open the DJ Patch Bay").
 2. Type your ADMIN_KEY password and press "Open". It works on your phone too.

STEP 2 - ADD A DJ
 1. Scroll to the bottom and open "+ Add a DJ".
 2. Type the DJ's name and genre. Paste their stream link into "Main stream link" (see STEP 3 for what
    link to ask for). If they have a second link (say, audio as well as video), put it in "Backup stream
    link" - the game switches to it by itself if the main one fails.
 3. Press "Add DJ". Their card appears in the DJ roster, with a "Test stream" button and their own
    private DJ link (/dj?key=...).
 4. Optional: send the DJ their private link (text or email it to them only). On it they can paste or
    change their own stream link, test it, and press "I'm live" / "End set" during their slot. If you'd
    rather start and stop them yourself, press "Lock" on their card.

STEP 3 - WHAT STREAM LINK TO ASK DJs FOR
 The game needs a PUBLIC link that starts with https:// and plays the stream itself (not a web page with
 a player on it). Two kinds work:
  - AUDIO (works on every device, the most reliable): an internet-radio link, usually ending in .mp3,
    .aac or .ogg (sometimes just /live or /stream). This is what an "Icecast" or "Shoutcast" server gives.
  - VIDEO: an HLS link ending in .m3u8 (live video), or an .mp4 file. Video shows on the stage screens.
    HLS plays on phones, tablets and in web browsers; some computers can't play it, so ask video DJs for
    an audio link too and put it in "Backup stream link".
 How a DJ gets an AUDIO link (generic steps - any Icecast host works, including free ones and your own):
  1. They get an Icecast (internet radio) server: an internet-radio hosting service, or their own Icecast
     server on a computer or cheap web server. It gives them: a server address, a port, a "mount" name
     (like /live) and a source password. It must offer an https:// listening link.
  2. In their DJ software they open the "Live broadcasting" (Mixxx: Options > Live Broadcasting) or
     "Broadcast" settings and type in those details. Type: Icecast 2. Format: MP3, 128 or 192 kbps.
     (Software without broadcasting built in - Serato, rekordbox - can use the free app BUTT.)
  3. They press "Enable live broadcasting" / "Start". Their listening link is then something like
       https://their-radio-host.example/live.mp3
     That's the link to paste into the patch bay.
 How a DJ gets a VIDEO link:
  1. They open OBS Studio (free) and add their camera and their DJ audio.
  2. In OBS, Settings > Stream, they choose a streaming service or server that gives out an HLS
     (.m3u8) playback link (many video hosting / live-streaming services do; so does your own server
     running a free media server). They paste in its server address and "stream key".
  3. They press "Start Streaming". The service shows the public playback link ending in .m3u8.
 Check any link: press "Test stream" on the DJ's card (or paste it into "Test any stream link") WHILE
 they're streaming. "WORKING" means players can hear it. The page tells you in plain words what's wrong
 if not (not streaming yet, wrong link, a web page instead of the stream, a home address...).

STEP 4 - PATCH A DJ ONTO A STAGE
 The page lists every live event, every public (listed) room, and any private room you ask for:
 type its 5-letter room code in "Show a private room" (the host sees it in the game: Settings > Online).
 1. On the room's or event's card, open "+ Patch a DJ into this room".
 2. Choose the Stage and the DJ. "Which stream": the DJ's main link, their backup link, or a link you paste.
 3. "When":
      LIVE NOW            - they're on straight away.
      Next in the running order - they wait in line on that stage; press GO LIVE when it's their turn.
      At a set time       - pick the date and time (YOUR time); they go live by themselves at that minute.
 4. Optional: "Set length in minutes" (e.g. 60) - the set stops by itself after that long.
 5. Press "Patch DJ". Within a few seconds everyone in that festival hears them.
 A live event can be patched BEFORE it opens: its stages play as soon as the organiser opens it.
 Want a live event? Open "+ Make a live event" at the bottom of the page (name, headline artist, when,
 and a ticket price or leave it empty for free). It appears in the game's Settings > Live events within
 about 10 minutes. The organiser opens it from the game with the event password (EVENT_HOST_KEY).

STEP 5 - DURING THE SHOW
  - "Now playing" at the top shows every stage that's live or has someone next.
  - GO LIVE (green) starts the next DJ in line. STOP (red) ends a set: that stage goes back to the
    festival's own music.
  - "Up" moves a queued DJ up the running order. "Remove" takes them off it.
  - Press "Refresh" to see the latest (the page doesn't update by itself).
  - Changed a DJ's link while they're on? Everyone switches to the new link within seconds.
  - A room's host can also patch stages from inside the game (Settings > Online > STAGES: a DJ name, a
    link, "Go live"), for friends' rooms without you. Stages YOU patched here always win - the host
    can't change them.

WHAT PLAYERS SEE AND HEAR
  - A pop-up "LIVE NOW on the Second Stage: DJ Nova (house)" when a DJ goes live.
  - The DJ's sound from that stage's speakers: loud in front, quieter across the field. That stage's own
    festival music goes quiet while the DJ plays, and the crowd in front cheers and dances.
  - Video streams on that stage's screens (the main stage's big wall and side screens).
  - A LIVE NOW card at the bottom right (on foot): the DJ on the stage nearest you, how long they've
    been on, how the stream is doing ("Stream good - about 5-10 s behind the DJ", "Buffering",
    "Tuning in", "Stream down - trying again, festival music meanwhile") and the rest of the lineup
    (who's live, who's next and when). Tap it to fold it away.
  - If a stream drops, the game tries again by itself (and tries the backup link); the festival's own
    music plays until the DJ is back.
  - The Festivals list (F7) shows "LIVE DJ: DJ Nova - Main Stage" on rooms with a DJ on.

KEEPING THE PATCH BAY (important on a FREE Render server)
 A free Render server forgets its files when it restarts (after 15 quiet minutes, and every update). The
 patch bay's DJs, links, set times and events are in the file patchbay-data.json, so on a free server:
 1. After adding or changing DJs, press "Download backup" at the bottom of the patch bay page. A file
    like patchbay-backup-2026-10-01.json downloads.
 2. render.com > your service > "Environment" > "Secret Files" > "Add Secret File":
      Filename:  patchbay.json
      Contents:  open the downloaded file in Notepad/TextEdit, copy ALL of it, paste it here.
    Save. From now on, whenever the server starts without its own file, it loads this backup.
 3. Do it again whenever you change the roster. (Or "Restore from a backup" on the page: paste the file.)
 With a permanent disk (STORE_DATA_DIR - see the Moon Shards section) you don't need any of this.
 Rooms (not events) are forgotten on a restart anyway - their hosts get new room codes.

TEST IT YOURSELF (about 10 minutes)
 1. Upload the files (above). Open https://YOUR-SERVER.onrender.com/admin/patch and log in.
 2. Add a DJ called "Test DJ" with any public internet-radio .mp3 link you can hear in your web browser.
    Press "Test stream" on their card: it should say WORKING.
 3. In the game: Settings > Online > Host online. Note the room code (e.g. ABCDE).
 4. On the patch bay page: type the code in "Show a private room" > press it. On the room's card:
    "+ Patch a DJ into this room" > Stage: Second Stage (or Main Stage) > DJ: Test DJ > LIVE NOW > Patch DJ.
 5. In the game (on foot): a "LIVE NOW" pop-up, the card bottom right, and the music from that stage.
    Walk towards and away from the stage - it gets louder and quieter.
 6. Have a friend join with your invite (or join from a second computer): they hear it too, from the
    same stage. Press STOP on the page: it stops for both of you and the festival's music comes back.
 7. Scheduling: patch the DJ with "At a set time" two minutes from now. Watch the card say
    "COMING UP ... starts in 2 min", then it goes live by itself.
 8. The DJ page: open the DJ's private link on your phone, add a queued set for them ("Next in the
    running order"), and press "I'm live" on the DJ page.


SAVED WORLDS - COME BACK TO THE SAME WORLD, LIKE MINECRAFT (Round 63)
A "saved world" is a festival kept on your server: the site, everything you and your friends build,
the porta-potty art and the stickers. Close it any time; next time it's exactly as you left it.
Nothing to switch on and NO new settings on Render - it's one new file (worlds.js) plus relay.js.

HOW TO UPDATE YOUR SERVER (about 3 minutes)
 1. Go to github.com and open your festival-tycoon-relay repository.
 2. Click "Add file" > "Upload files".
 3. Drag in these two files from this folder:  worlds.js  (new)  and  relay.js  (changed).
    Also drag in README.txt if you keep it there. (NOT the node_modules folder.)
 4. Click the green "Commit changes" button.
 5. Render restarts the server by itself in a minute or two. To check: render.com > your service >
    "Logs" should say "Festival Tycoon relay listening on ...". (If it doesn't restart by itself:
    your service > "Manual Deploy" > "Deploy latest commit".)
 6. Check it in your web browser:  https://YOUR-SERVER.onrender.com/worlds/status
    It should show  "ok":true  and how many worlds there are.

KEEP WORLDS SAFE (important on a FREE Render server)
 A free Render server forgets its files every time it restarts (after 15 quiet minutes, and on every
 update) - saved worlds would only last until then. If you already gave the server a permanent disk for
 the Moon Shards store (STORE_DATA_DIR - see "ONE-TIME SETUP" in the Moon Shards section), you're done:
 worlds are kept on that same disk, in a folder called "worlds". If not, do step B of that section
 (the disk and STORE_DATA_DIR). The game warns players when the server can't keep worlds.
 /worlds/status shows "saving":true once worlds are kept on a disk.

HOW PLAYERS USE IT
 1. Festivals (F7) > "+ Host a festival" > SAVED WORLDS > "+ New saved world". Type a name, press
    "Create and open". The world starts as your festival as it is right now.
 2. Your career is saved first and put aside while the world is open (it comes back exactly as it was
    when you close the world). The world is its own festival: build, decorate, run days with friends.
 3. Invite friends as usual (the invite is copied for you), or switch on Go public.
 4. Changes are saved to the server a few seconds after they happen ("All changes saved" in Settings).
 5. Close it like any room (Settings > Play with friends > Close to friends). Next time: Festivals >
    "+ Host a festival" > CONTINUE A SAVED WORLD > Continue.
 6. Friends who have played there see the world in their Festivals list whenever it's open ("YOUR SAVED
    WORLD"), and can join it with one click. The owner can let friends HOST it too ("Friends who can
    host" > "Let them host") - then they can open it themselves when you're not online. Only the owner
    can delete a world.

LIMITS (all fine as they are; optional settings on Render if you ever want to change them)
 - Each player can own 5 worlds (WORLDS_PER_PLAYER). The server holds up to 3000 worlds (WORLDS_MAX)
   and 800 MB (WORLDS_TOTAL_MB). One world can be up to 1 MB.
 - A world nobody has played or saved for 90 days is removed (WORLDS_KEEP_DAYS); an empty one after 14.
 - Opening a world needs its owner's (or an allowed friend's) game - a player's world key never leaves
   their game except to your server, and the server only keeps a scrambled (hashed) version of it.
 - WORLDS_DIR: a different folder for the worlds (normally not needed).

TEST IT YOURSELF (about 10 minutes)
 1. In the game: Settings > Play with friends > make sure the server address is set.
 2. Festivals (F7) > "+ Host a festival" > "+ New saved world" > name it "Test world" > Create and open.
    You should see "Your saved world "Test world" is open!".
 3. Build something (or draw in a porta-potty). Wait 10 seconds. Settings > Play with friends shows
    "All changes saved to the server".
 4. Close to friends. Your own career comes back.
 5. Festivals > "+ Host a festival" > Continue "Test world": what you built is still there.
 6. With a friend (or a second computer): join with the invite, build something together, close,
    and open it again - your friend's builds are there too. Your friend now sees "Test world" in their
    Festivals list whenever you have it open.



THE PUBLIC FESTIVAL (Round 66)
One festival that is always open (24/7), that anyone can join or leave, and that nobody hosts. Setting it
up (upload, keeping it awake for free or for about $7 a month, DJ set times): see PUBLIC_FESTIVAL_SETUP.txt.
 - Players reach it at /public (the game does this). GET /public = how many are inside, the festival clock
   and the roles being played. GET /schedule?target=event:public = the DJ set times. GET /healthz = "ok".
 - Its DJ schedule is on /admin/patch, card "The public festival (always open, 24/7)".
 - Settings (optional): PUBLIC_CAPACITY (60), PUBLIC_DAY_SECONDS (7200).



PLAY STATS - YOUR PRIVATE DASHBOARD (Round 71)
Who plays, for how long, what they do, and money - on one password-protected page:
    https://server.newmoonsamedark.com/admin/stats
It's also on your /admin page ("Play stats" > Open play stats).

ONE-TIME SETUP
 1. Upload analytics.js (new) plus the changed relay.js, payments.js, store.js and .gitignore to GitHub,
    the same way as before. Render restarts the server by itself.
 2. The password is your ADMIN_KEY (the same one as /admin). To make it MoonVision:
    Render > your server > Environment > ADMIN_KEY > Edit > type MoonVision > Save Changes.
    (It must be at least 8 letters. Never put the password in a file on GitHub - your repository is public.)
 3. To KEEP the numbers when the server restarts, the server needs the permanent disk (STORE_DATA_DIR - see
    "Moon Shards", step B). Without it the page works but starts from zero after every restart, and says so.

WHAT'S ON THE PAGE
 - Right now: players in the game, walking the festival, in the Open Festival, in friends' rooms.
 - Players: everyone who ever played (one copy of the game on one device = one player), accounts made,
   daily / weekly / monthly players (DAU / WAU / MAU), new players, a 30-day chart.
 - How long they play: session length, sessions and play time per player, total hours, time on foot.
 - Do they come back: day 1 / 7 / 30 retention, per starting day.
 - From first launch to hooked: how many reach each step (demo, own festival, finished, walked, online, paid).
 - Platforms, versions, where they got it, languages, devices; mini-games played; festivals and grades;
   money (sales, paying accounts, ARPU / ARPPU); crashes with where in the code they happened.
 - Every player (search, newest first) and every account, and two CSV downloads for a spreadsheet.

GOOD TO KNOW
 - Players can switch it off: Settings > Game > Share play stats. Those players aren't counted.
 - Playing in the Unity editor is never counted (so your own testing doesn't show up).
 - Days are counted in UTC (a new day starts at 8 pm US Eastern in summer, 7 pm in winter).
 - 10 wrong passwords from one address lock that address out for 10 minutes.
 - Files on the disk: analytics.json (everything) and analytics.json.bak (the version before).
