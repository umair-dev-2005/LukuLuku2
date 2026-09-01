import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

type Language = 'en' | 'nl' | 'srn';

const LANGUAGE_STORAGE_KEY = 'lukuluku_language_v1';
const languageListeners = new Set<() => void>();

const translations = {
  // Tabs
  'tab.home': { nl: 'Home', en: 'Home', srn: 'Doro' },
  'tab.momenti': { nl: 'Momenti', en: 'Momenti', srn: 'Momenti' },
  'tab.search': { nl: 'Zoeken', en: 'Search', srn: 'Suku' },
  'tab.profile': { nl: 'Profiel', en: 'Profile', srn: 'Profail' },
  'tab.create': { nl: 'Maken', en: 'Create', srn: 'Mek' },

  // Home
  'home.notifications': { nl: 'Meldingen', en: 'Notifications', srn: 'Meksi' },
  'home.spotlight': { nl: 'Creator Spotlight', en: 'Creator Spotlight', srn: 'Meki na frondo' },
  'home.leaderboard': { nl: 'Leaderboard', en: 'Leaderboard', srn: 'Top list' },
  'home.topCreators': { nl: 'Top Creators', en: 'Top Creators', srn: 'Top meki' },
  'home.seeAll': { nl: 'Bekijk alles', en: 'See all', srn: 'Sieni ala' },
  'home.forYou': { nl: 'Voor jou', en: 'For you', srn: 'Fu yu' },
  'home.bangi': { nl: 'Bangi Feed', en: 'Bangi Feed', srn: 'Bangi feed' },
  'home.games': { nl: 'Mini Games', en: 'Mini Games', srn: 'Spel' },
  'home.trending': { nl: 'Trending', en: 'Trending', srn: 'Top now' },
  'home.new': { nl: 'Nieuw', en: 'New', srn: 'Njoe' },
  'home.continueWatching': { nl: 'Verder kijken', en: 'Continue watching', srn: 'Go on waka' },
  'home.resumeWatching': { nl: 'Verder kijken', en: 'Resume watching', srn: 'Go on waka' },

  // Leaderboards
  'leaderboards.title': { nl: 'Leaderboard', en: 'Leaderboard', srn: 'Leaderboard' },
  'leaderboards.tapiners': { nl: 'Tapins', en: 'Tapins', srn: 'Tapins' },
  'leaderboards.views': { nl: 'Weergaven', en: 'Views', srn: 'Views' },
  'leaderboards.posts': { nl: 'Bangi Posts', en: 'Bangi Posts', srn: 'Bangi Posts' },
  'leaderboards.loading': { nl: 'Laden…', en: 'Loading…', srn: 'Laden…' },
  'leaderboards.empty': { nl: 'Nog geen activiteit. Kom later terug! 🚀', en: 'No activity yet. Come back later! 🚀', srn: 'Nog no activity. Kon bak later! 🚀' },
  'leaderboards.thisWeek': { nl: 'deze week', en: 'this week', srn: 'disi week' },
  'leaderboards.allTime': { nl: 'aller tijden', en: 'all time', srn: 'ala ten' },

  // Create
  'create.title': { nl: 'Maken', en: 'Create', srn: 'Mek' },
  'create.uploadVideo': { nl: 'Video uploaden', en: 'Upload Video', srn: 'Upload video' },
  'create.uploadVideoDesc': { nl: 'Deel een lange video', en: 'Share a long video', srn: 'Sani wan bigi video' },
  'create.createMomenti': { nl: 'Momenti maken', en: 'Create Momenti', srn: 'Mek Momenti' },
  'create.createMomentiDesc': { nl: 'Deel een kort moment', en: 'Share a short moment', srn: 'Sani wan smol moment' },
  'create.communityPost': { nl: 'Bangi bericht', en: 'Bangi Post', srn: 'Bangi sani' },
  'create.communityPostDesc': { nl: 'Plaats een bericht in de Bangi-feed', en: 'Post to the Bangi feed', srn: 'Puti sani na Bangi feed' },
  'create.advertise': { nl: 'Adverteren met LukuLuku Ads', en: 'Advertise with LukuLuku Ads', srn: 'Adverteer nanga LukuLuku Ads' },
  'create.advertiseDesc': { nl: 'Start een sponsorcampagne voor je bedrijf of product', en: 'Start a sponsored campaign for your business or product', srn: 'Start wan sponsored campaign fu yu business of product' },
  'create.comingSoon': { nl: 'Binnenkort beschikbaar', en: 'Coming soon', srn: 'A e kon soon' },

  // Games
  'games.title': { nl: 'Spellen', en: 'Games', srn: 'Spel' },
  'games.loadMore': { nl: 'Meer games laden', en: 'Load more games', srn: 'Laden moro spel' },

  // Advertise
  'advertise.title': { nl: 'Adverteren met LukuLuku Ads', en: 'Advertise with LukuLuku Ads', srn: 'Adverteer nanga LukuLuku Ads' },
  'advertise.loading': { nl: 'Advertentieformulier laden…', en: 'Loading ad form…', srn: 'Load ad form…' },
  'advertise.introTitle': { nl: 'Start een campagne', en: 'Start a campaign', srn: 'Start wan campaign' },
  'advertise.introDesc': { nl: 'Maak direct in de app je advertentieaanvraag aan en kies de juiste betaalmethode.', en: 'Create your ad request directly in the app and choose the right payment method.', srn: 'Mek yu ad request direct na app en kies a right payment method.' },
  'advertise.companySection': { nl: 'Bedrijfsgegevens', en: 'Company details', srn: 'Company details' },
  'advertise.companyName': { nl: 'Bedrijfsnaam *', en: 'Company name *', srn: 'Company name *' },
  'advertise.contactName': { nl: 'Contactnaam *', en: 'Contact name *', srn: 'Contact name *' },
  'advertise.email': { nl: 'E-mailadres *', en: 'Email address *', srn: 'Email address *' },
  'advertise.phone': { nl: 'Telefoon', en: 'Phone', srn: 'Phone' },
  'advertise.website': { nl: 'Website', en: 'Website', srn: 'Website' },
  'advertise.campaignSection': { nl: 'Campagne', en: 'Campaign', srn: 'Campaign' },
  'advertise.campaignTitle': { nl: 'Campagnetitel *', en: 'Campaign title *', srn: 'Campaign title *' },
  'advertise.campaignDescription': { nl: 'Campagnebeschrijving', en: 'Campaign description', srn: 'Campaign description' },
  'advertise.adTypeSection': { nl: 'Advertentietype', en: 'Ad type', srn: 'Ad type' },
  'advertise.sponsored': { nl: 'Sponsored', en: 'Sponsored', srn: 'Sponsored' },
  'advertise.sponsoredDesc': { nl: 'Gesponsorde feedplaatsing en cards', en: 'Sponsored feed placements and cards', srn: 'Sponsored feed placements and cards' },
  'advertise.banner': { nl: 'Banner', en: 'Banner', srn: 'Banner' },
  'advertise.bannerDesc': { nl: 'Visuele promoties met vaste creative', en: 'Visual promotions with static creative', srn: 'Visual promotions with static creative' },
  'advertise.videoPreroll': { nl: 'Video preroll', en: 'Video preroll', srn: 'Video preroll' },
  'advertise.videoPrerollDesc': { nl: 'Videoads vóór content', en: 'Video ads before content', srn: 'Video ads before content' },
  'advertise.creativeSection': { nl: 'Creative', en: 'Creative', srn: 'Creative' },
  'advertise.uploadCreative': { nl: 'Creative uploaden', en: 'Upload creative', srn: 'Upload creative' },
  'advertise.changeCreative': { nl: 'Creative wijzigen', en: 'Change creative', srn: 'Change creative' },
  'advertise.ctaUrl': { nl: 'CTA-URL', en: 'CTA URL', srn: 'CTA URL' },
  'advertise.paymentSection': { nl: 'Betaling', en: 'Payment', srn: 'Payment' },
  'advertise.submit': { nl: 'Advertentie versturen', en: 'Submit ad', srn: 'Submit ad' },
  'advertise.permissionTitle': { nl: 'Toegang nodig', en: 'Permission needed', srn: 'Permission needed' },
  'advertise.permissionDesc': { nl: 'Geef toegang tot je foto’s om een creative te uploaden.', en: 'Allow access to your photos to upload a creative.', srn: 'Gi access gi yu fotos fu upload wan creative.' },
  'advertise.loginTitle': { nl: 'Login nodig', en: 'Sign in required', srn: 'Login nodig' },
  'advertise.loginDesc': { nl: 'Log eerst in om een advertentie aan te maken.', en: 'Sign in first to create an ad.', srn: 'Login fas fu mek wan ad.' },
  'advertise.missingTitle': { nl: 'Ontbrekende velden', en: 'Missing fields', srn: 'Missing fields' },
  'advertise.missingDesc': { nl: 'Vul minstens bedrijfsnaam, contactnaam, email en campagnetitel in.', en: 'Fill in at least company name, contact name, email and campaign title.', srn: 'Puti tenki company, contact, email en campaign title.' },
  'advertise.successTitle': { nl: 'Verstuurd', en: 'Sent', srn: 'Sent' },
  'advertise.successDesc': { nl: 'Je advertentieaanvraag is ingediend. We nemen het vanaf hier over.', en: 'Your ad request has been submitted. We take it from here.', srn: 'Yu ad request de send. Wi teke am from hier.' },
  'advertise.failTitle': { nl: 'Kon niet versturen', en: 'Could not send', srn: 'Could not send' },
  'advertise.failDesc': { nl: 'Probeer het opnieuw.', en: 'Please try again.', srn: 'Try again.' },

  // Create Post
  'createPost.title': { nl: 'Nieuw Bangi bericht', en: 'New Bangi Post', srn: 'Njoe Bangi sani' },
  'createPost.placeholder': { nl: 'Wat wil je delen met de community?', en: 'What do you want to share with the community?', srn: 'Wani yu wani leti gi a community?' },
  'createPost.post': { nl: 'Plaatsen', en: 'Post', srn: 'Poti' },
  'createPost.addImage': { nl: 'Foto toevoegen', en: 'Add photo', srn: 'Puti foto' },
  'createPost.moderationNote': { nl: 'AI-moderatie actief', en: 'AI moderation active', srn: 'AI check de' },
  'createPost.moderating': { nl: 'Afbeelding wordt gecontroleerd...', en: 'Checking image...', srn: 'Check foto...' },
  'createPost.permissionNeeded': { nl: 'Toestemming nodig', en: 'Permission needed', srn: 'Permisi wan' },
  'createPost.permissionDesc': { nl: 'Geef toegang tot je fotobibliotheek om afbeeldingen te kunnen delen.', en: 'Allow access to your photo library to share images.', srn: 'Gi toegang gi yu foto libi' },
  'createPost.emptyError': { nl: 'Schrijf iets of voeg een foto toe.', en: 'Write something or add a photo.', srn: 'Skrifi sani or puti foto' },
  'createPost.signInRequired': { nl: 'Je moet ingelogd zijn om te posten.', en: 'You need to be signed in to post.', srn: 'Yu mus de ini login fu poti' },
  'createPost.rejected': { nl: 'Upload geweigerd', en: 'Upload rejected', srn: 'Upload no ben go' },
  'createPost.rejectedDesc': { nl: 'Deze content overtreedt onze communityrichtlijnen. Ongepaste afbeeldingen (naaktheid, geweld, adult content) zijn niet toegestaan.', en: 'This content violates our community guidelines. Inappropriate images (nudity, violence, adult content) are not allowed.', srn: 'Disi sani no yere gi a rules' },
  'createPost.success': { nl: 'Geplaatst!', en: 'Posted!', srn: 'Poti!' },
  'createPost.successDesc': { nl: 'Je Bangi bericht is gepubliceerd.', en: 'Your Bangi post has been published.', srn: 'Yu Bangi sani de opo' },

  // Search
  'search.placeholder': { nl: "Zoek video's en kanalen...", en: 'Search videos and channels...', srn: 'Suku video en kanaal...' },
  'search.noResults': { nl: 'Geen resultaten gevonden', en: 'No results found', srn: 'No kisi' },
  'search.prompt': { nl: "Zoek naar video's en kanalen", en: 'Search for videos and channels', srn: 'Suku video en kanaal' },
  'search.tapiners': { nl: 'tapiners', en: 'tapiners', srn: 'tapiners' },

  // Profile / Auth
  'auth.welcome': { nl: 'Welkom bij LukuLuku', en: 'Welcome to LukuLuku', srn: 'Welkom na LukuLuku' },
  'auth.subtitle': { nl: 'Log in om verder te gaan', en: 'Sign in to continue', srn: 'Login fu go moro' },
  'auth.emailPlaceholder': { nl: 'E-mailadres', en: 'Email address', srn: 'Email adres' },
  'auth.passwordPlaceholder': { nl: 'Wachtwoord', en: 'Password', srn: 'Password' },
  'auth.signIn': { nl: 'Inloggen', en: 'Sign in', srn: 'Login' },
  'auth.signingIn': { nl: 'Bezig...', en: 'Signing in...', srn: 'Signing in...' },
  'auth.signUp': { nl: 'Account aanmaken', en: 'Create account', srn: 'Create account' },
  'auth.signingUp': { nl: 'Versturen...', en: 'Creating...', srn: 'Creating...' },
  'auth.resendConfirmation': { nl: 'Bevestigingsmail opnieuw sturen', en: 'Resend confirmation email', srn: 'Resend confirmation email' },
  'auth.resending': { nl: 'Opnieuw versturen...', en: 'Resending...', srn: 'Resending...' },
  'auth.forgotPassword': { nl: 'Wachtwoord vergeten?', en: 'Forgot password?', srn: 'Forgot password?' },
  'auth.resetPassword': { nl: 'Wachtwoord reset', en: 'Reset password', srn: 'Reset password' },
  'auth.resetPasswordDesc': { nl: 'Check je email voor de reset-link.', en: 'Check your email for the reset link.', srn: 'Check yu email fu a reset link.' },
  'auth.useEmailLoginBelow': { nl: 'Gebruik de email/wachtwoord login hieronder.', en: 'Use the email/password login below.', srn: 'Use the email/password login below.' },
  'auth.emailRequired': { nl: 'Vul je email in.', en: 'Enter your email.', srn: 'Puti yu email in.' },
  'auth.emailPasswordRequired': { nl: 'Vul email en wachtwoord in.', en: 'Enter email and password.', srn: 'Puti email en password in.' },
  'auth.accountCreated': { nl: 'Account aangemaakt', en: 'Account created', srn: 'Account created' },
  'auth.accountCreatedDesc': { nl: 'We hebben een bevestigingsmail gestuurd. Check je inbox en spam, en tik daarna op de bevestigingslink.', en: 'We sent a confirmation email. Check your inbox and spam, then tap the confirmation link.', srn: 'Wi send wan confirmation email. Check yu inbox en spam, daarna tap a confirmation link.' },
  'auth.confirmationSentTitle': { nl: 'Bevestigingsmail verstuurd', en: 'Confirmation email sent', srn: 'Confirmation email sent' },
  'auth.confirmationSentDesc': { nl: 'We hebben de bevestigingsmail opnieuw verstuurd. Check ook even je spam of ongewenste mail.', en: 'We sent the confirmation email again. Also check your spam or junk mail.', srn: 'Wi send a confirmation email weer. Check yu spam or junk mail too.' },
  'auth.loginPrompt': { nl: 'Login', en: 'Sign in', srn: 'Login' },
  'auth.googlePrompt': { nl: 'Gebruik de email/wachtwoord login hieronder.', en: 'Use the email/password login below.', srn: 'Use the email/password login below.' },

  // Monetization
  'monetization.title': { nl: 'Monetisatie', en: 'Monetization', srn: 'Monetization' },
  'monetization.status': { nl: 'Monetisatiestatus', en: 'Monetization Status', srn: 'Monetization status' },
  'monetization.active': { nl: 'Gemonetiseerd', en: 'Monetized', srn: 'Monetized' },
  'monetization.inactive': { nl: 'Niet gemonetiseerd', en: 'Not monetized', srn: 'No monetized' },
  'monetization.walletLockedTitle': { nl: 'Wallet vergrendeld', en: 'Wallet locked', srn: 'Wallet locked' },
  'monetization.walletLockedDesc': { nl: 'Je kunt je Uni5Pay wallet pas koppelen zodra je 1000 tapins hebt bereikt.', en: 'You can link your Uni5Pay wallet once you reach 1,000 tapins.', srn: 'Yu kan link yu Uni5Pay wallet wen yu reach 1,000 tapins.' },
  'monetization.walletLockedUntil': { nl: 'Wallet koppelen opent pas na 1000 tapins', en: 'Wallet linking unlocks after 1,000 tapins', srn: 'Wallet linking unlocks after 1,000 tapins' },
  'monetization.tapinProgress': { nl: 'Tapin voortgang', en: 'Tapin Progress', srn: 'Tapin progress' },
  'monetization.tapinDesc': { nl: 'Bereik 1.000 tapins om te monetiseren', en: 'Reach 1,000 tapins to monetize', srn: 'Bereik 1,000 tapins fu monetized' },
  'monetization.tapinReached': { nl: 'Doel behaald!', en: 'Goal reached!', srn: 'Goal kiri' },
  'monetization.revenueShare': { nl: 'Inkomsten verdeling', en: 'Revenue Share', srn: 'Revenue share' },
  'monetization.yourShare': { nl: 'Jouw aandeel', en: 'Your share', srn: 'Yu share' },
  'monetization.bonusShare': { nl: 'Bonus', en: 'Bonus', srn: 'Bonus' },
  'monetization.walletTitle': { nl: 'Uitbetalingswallet', en: 'Payout wallet', srn: 'Payout wallet' },
  'monetization.walletDesc': { nl: 'Koppel je Uni5Pay wallet of voeg een BEP20 USDT wallet toe voor uitbetalingen', en: 'Link your Uni5Pay wallet or add a BEP20 USDT wallet for payouts', srn: 'Link yu Uni5Pay wallet of puti wan BEP20 USDT wallet fu payout' },
  'monetization.walletTypeLabel': { nl: 'Wallettype', en: 'Wallet type', srn: 'Wallet type' },
  'monetization.walletTypeUni5Pay': { nl: 'Uni5Pay', en: 'Uni5Pay', srn: 'Uni5Pay' },
  'monetization.walletTypeBep20': { nl: 'BEP20 USDT', en: 'BEP20 USDT', srn: 'BEP20 USDT' },
  'monetization.walletNumber': { nl: 'Wallet nummer', en: 'Wallet number', srn: 'Wallet nomba' },
  'monetization.walletNumberPlaceholder': { nl: 'Voer je Uni5Pay wallet nummer in', en: 'Enter your Uni5Pay wallet number', srn: 'Puti yu Uni5Pay wallet nomba' },
  'monetization.walletAddress': { nl: 'Wallet adres', en: 'Wallet address', srn: 'Wallet adres' },
  'monetization.walletAddressPlaceholder': { nl: 'Voer je BEP20 USDT wallet adres in', en: 'Enter your BEP20 USDT wallet address', srn: 'Puti yu BEP20 USDT wallet adres' },
  'monetization.accountHolder': { nl: 'Rekeninghouder', en: 'Account holder', srn: 'Account holder' },
  'monetization.accountHolderPlaceholder': { nl: 'Naam op je rekening', en: 'Name on your account', srn: 'Nem fu yu account' },
  'monetization.saveWallet': { nl: 'Wallet opslaan', en: 'Save wallet', srn: 'Sefi wallet' },
  'monetization.walletSaved': { nl: 'Wallet opgeslagen!', en: 'Wallet saved!', srn: 'Wallet de sefi' },
  'monetization.walletSavedDesc': { nl: 'Je uitbetalingswallet is gekoppeld.', en: 'Your payout wallet has been linked.', srn: 'Yu payout wallet de link' },
  'monetization.walletLinked': { nl: 'Wallet gekoppeld', en: 'Wallet linked', srn: 'Wallet link' },
  'monetization.editWallet': { nl: 'Bewerken', en: 'Edit', srn: 'Mek' },
  'monetization.withdraw': { nl: 'Opnemen', en: 'Withdraw', srn: 'Teki opo' },
  'monetization.withdrawTitle': { nl: 'Opnemen', en: 'Withdraw', srn: 'Teki opo' },
  'monetization.withdrawDesc': { nl: 'Vraag een uitbetaling aan naar je Uni5Pay wallet', en: 'Request a payout to your Uni5Pay wallet', srn: 'Ask fu payout na yu wallet' },
  'monetization.withdrawAmount': { nl: 'Bedrag (SRD)', en: 'Amount (SRD)', srn: 'Amount (SRD)' },
  'monetization.withdrawAmountPlaceholder': { nl: 'Voer bedrag in', en: 'Enter amount', srn: 'Puti amount' },
  'monetization.withdrawSubmit': { nl: 'Opname aanvragen', en: 'Request Withdrawal', srn: 'Ask withdrawal' },
  'monetization.withdrawSuccess': { nl: 'Opname aangevraagd!', en: 'Withdrawal requested!', srn: 'Withdrawal de ask' },
  'monetization.withdrawSuccessDesc': { nl: 'Je uitbetaling wordt verwerkt naar je Uni5Pay wallet.', en: 'Your payout will be processed to your Uni5Pay wallet.', srn: 'Yu payout go pass' },
  'monetization.withdrawHistory': { nl: 'Opnamegeschiedenis', en: 'Withdrawal History', srn: 'Withdrawal history' },
  'monetization.noWithdrawals': { nl: 'Nog geen opnames', en: 'No withdrawals yet', srn: 'No withdrawal yet' },
  'monetization.pending': { nl: 'In behandeling', en: 'Pending', srn: 'Pending' },
  'monetization.completed': { nl: 'Voltooid', en: 'Completed', srn: 'Done' },
  'monetization.rejected': { nl: 'Afgewezen', en: 'Rejected', srn: 'Rejected' },
  'monetization.balance': { nl: 'Beschikbaar saldo', en: 'Available balance', srn: 'Balance fu use' },
  'monetization.noWalletYet': { nl: 'Koppel eerst je wallet', en: 'Link your wallet first', srn: 'Link yu wallet fas' },
  'monetization.lockedTitle': { nl: 'Monetisatie vergrendeld', en: 'Monetization locked', srn: 'Monetization lock' },
  'monetization.lockedDesc': { nl: 'Je hebt nog niet genoeg tapins. Blijf content maken!', en: 'You don\'t have enough tapins yet. Keep creating content!', srn: 'Yu no abi enough tapins yet' },

  // Video Player
  'video.views': { nl: 'weergaven', en: 'views', srn: 'view' },
  'video.share': { nl: 'Delen', en: 'Share', srn: 'Share' },
  'video.tapIn': { nl: 'TAPIN', en: 'TAPIN', srn: 'TAPIN' },
  'video.comments': { nl: 'Reacties', en: 'Comments', srn: 'Comments' },
  'video.noComments': { nl: 'Nog geen reacties', en: 'No comments yet', srn: 'No comments yet' },
  'video.moreVideos': { nl: 'Meer video\'s', en: 'More videos', srn: 'Moro video' },
  'video.addComment': { nl: 'Plaats een reactie...', en: 'Add a comment...', srn: 'Poti wan comment...' },
  'video.reply': { nl: 'Reageer', en: 'Reply', srn: 'Reply' },
  'video.replies': { nl: 'reacties', en: 'replies', srn: 'replies' },
  'video.viewReplies': { nl: 'Bekijk {count} reacties', en: 'View {count} replies', srn: 'Sien {count} replies' },
  'video.hideReplies': { nl: 'Verberg reacties', en: 'Hide replies', srn: 'Hide replies' },
  'video.send': { nl: 'Verstuur', en: 'Send', srn: 'Sende' },
  'video.signInToComment': { nl: 'Log in om te reageren', en: 'Sign in to comment', srn: 'Login fu comment' },
  'video.signInToLike': { nl: 'Log in om te liken', en: 'Sign in to like', srn: 'Login fu like' },
  'video.commentAdded': { nl: 'Reactie geplaatst', en: 'Comment added', srn: 'Comment de add' },

  // Notifications
  'notifications.title': { nl: 'Meldingen', en: 'Notifications', srn: 'Meksi' },
  'notifications.empty': { nl: 'Geen meldingen', en: 'No notifications', srn: 'No meksi' },
  'notifications.emptyDesc': { nl: 'Wanneer iemand je video liket of een reactie plaatst, zie je dat hier', en: 'When someone likes your video or comments, you\'ll see it here', srn: 'Wan man like of comment, yu e si am hier' },
  'notifications.likedVideo': { nl: 'heeft je video geliked', en: 'liked your video', srn: 'like yu video' },
  'notifications.commentedVideo': { nl: 'heeft gereageerd op je video', en: 'commented on your video', srn: 'comment fu yu video' },
  'notifications.likedPost': { nl: 'heeft je Bangi post geliked', en: 'liked your Bangi post', srn: 'like yu Bangi post' },
  'notifications.commentedPost': { nl: 'heeft gereageerd op je Bangi post', en: 'commented on your Bangi post', srn: 'comment fu yu Bangi post' },
  'notifications.repliedComment': { nl: 'heeft op je reactie gereageerd', en: 'replied to your comment', srn: 'reply na yu comment' },
  'notifications.newTapIn': { nl: 'heeft TAPIN gedaan', en: 'tapped in', srn: 'tap in' },
  'notifications.markAllRead': { nl: 'Alles gelezen', en: 'Mark all read', srn: 'Mark all read' },

  // Bangi post
  'bangi.comments': { nl: 'Reacties', en: 'Comments', srn: 'Comments' },
  'bangi.noComments': { nl: 'Nog geen reacties. Wees de eerste!', en: 'No comments yet. Be the first!', srn: 'No comments yet. Be the first!' },
  'bangi.relatedPosts': { nl: 'Andere Bangi posts', en: 'Other Bangi posts', srn: 'Othro Bangi posts' },
  'bangi.trendingPosts': { nl: 'Trending Bangi posts', en: 'Trending Bangi posts', srn: 'Trending Bangi posts' },
  'bangi.noRelatedPosts': { nl: 'Nog geen andere posts om te tonen', en: 'No other posts to show yet', srn: 'No other posts yet' },
  'bangi.noTrendingPosts': { nl: 'Nog geen trending posts beschikbaar', en: 'No trending posts available yet', srn: 'No trending posts yet' },

  // Channel
  'channel.notFound': { nl: 'Kanaal niet gevonden', en: 'Channel not found', srn: 'Kanaal no de' },
  'channel.videos': { nl: "Video's", en: 'Videos', srn: 'Video' },
  'channel.momenti': { nl: 'Momenti', en: 'Momenti', srn: 'Momenti' },
  'channel.community': { nl: 'Bangi', en: 'Bangi', srn: 'Bangi' },
  'channel.noVideos': { nl: "Nog geen video's", en: 'No videos yet', srn: 'No video yet' },
  'channel.noMomenti': { nl: 'Nog geen momenti', en: 'No momenti yet', srn: 'No momenti yet' },
  'channel.noPosts': { nl: 'Nog geen Bangi berichten', en: 'No Bangi posts yet', srn: 'No Bangi yet' },

  // Time
  'time.justNow': { nl: 'Zojuist', en: 'Just now', srn: 'Now now' },
  'time.minutesAgo': { nl: 'min. geleden', en: 'min. ago', srn: 'min ago' },
  'time.hoursAgo': { nl: 'uur geleden', en: 'hours ago', srn: 'hour ago' },
  'time.daysAgo': { nl: 'dagen geleden', en: 'days ago', srn: 'days ago' },
  'time.weeksAgo': { nl: 'weken geleden', en: 'weeks ago', srn: 'weeks ago' },
  'time.monthsAgo': { nl: 'maanden geleden', en: 'months ago', srn: 'months ago' },
  'time.yearsAgo': { nl: 'jaar geleden', en: 'years ago', srn: 'years ago' },

  // Legal / Settings
  'legal.terms': { nl: 'Algemene Voorwaarden', en: 'Terms & Conditions', srn: 'Rules' },
  'legal.privacy': { nl: 'Privacybeleid', en: 'Privacy Policy', srn: 'Privacy' },
  'legal.about': { nl: 'Over LukuLuku', en: 'About LukuLuku', srn: 'About LukuLuku' },
  'settings.title': { nl: 'Instellingen', en: 'Settings', srn: 'Settings' },
  'settings.signOut': { nl: 'Uitloggen', en: 'Sign out', srn: 'Go out' },
  'settings.legal': { nl: 'Juridisch', en: 'Legal', srn: 'Legal' },
  'common.error': { nl: 'Fout', en: 'Error', srn: 'Error' },
  'profile.user': { nl: 'Gebruiker', en: 'User', srn: 'User' },
  'profile.title': { nl: 'Profiel', en: 'Profile', srn: 'Profail' },
  'profile.language': { nl: 'Taal', en: 'Language', srn: 'Langua' },
  'profile.languageDesc': { nl: 'Kies je voorkeurstaal', en: 'Choose your preferred language', srn: 'Kies yu language' },
  'profile.languageEnglish': { nl: 'Engels', en: 'English', srn: 'Inglish' },
  'profile.languageDutch': { nl: 'Nederlands', en: 'Dutch', srn: 'Holland' },
  'profile.languageSranan': { nl: 'Sranan Tongo', en: 'Sranan Tongo', srn: 'Sranan Tongo' },
  'profile.videosTab': { nl: 'Video\'s', en: 'Videos', srn: 'Video' },
  'profile.momentiTab': { nl: 'Momenti', en: 'Momenti', srn: 'Momenti' },
  'profile.bangiTab': { nl: 'Bangi', en: 'Bangi', srn: 'Bangi' },
  'profile.channelSettings': { nl: 'Kanaalinstellingen', en: 'Channel settings', srn: 'Kanaal settings' },
  'profile.studioDesc': { nl: 'Beheer je kanaal, monetisatie en content', en: 'Manage your channel, monetization and content', srn: 'Manage yu kanaal, monetization en content' },
  'profile.linksTitle': { nl: 'Links', en: 'Links', srn: 'Links' },
  'profile.sharedLinks': { nl: 'Gedeelde links', en: 'Shared links', srn: 'Shared links' },
  'profile.linksFromBio': { nl: 'Links uit bio', en: 'Links from bio', srn: 'Links from bio' },
  'profile.studioSection': { nl: 'LukuLuku Studio', en: 'LukuLuku Studio', srn: 'LukuLuku Studio' },
  'profile.withdrawThreshold': { nl: 'Opnemen kan vanaf SRD 100', en: 'Withdrawals start at SRD 100', srn: 'Withdraw start na SRD 100' },
  'profile.withdrawalHistory': { nl: 'Opnamegeschiedenis', en: 'Withdrawal history', srn: 'Withdrawal history' },
  'profile.noVideos': { nl: 'Nog geen video\'s', en: 'No videos yet', srn: 'No video yet' },
  'profile.noMomenti': { nl: 'Nog geen momenti', en: 'No momenti yet', srn: 'No momenti yet' },
  'profile.noBangi': { nl: 'Nog geen Bangi berichten', en: 'No Bangi posts yet', srn: 'No Bangi posts yet' },
  'profile.tappedChannels': { nl: 'Getapte kanalen', en: 'Tapped channels', srn: 'Tap kanalen' },
  'profile.cancel': { nl: 'Annuleren', en: 'Cancel', srn: 'Cancel' },
  'profile.verificationTitle': { nl: 'Verificatie', en: 'Verification', srn: 'Verification' },
  'profile.verificationCardDesc': { nl: 'Vraag verificatie aan voor je profiel en kanalen', en: 'Request verification for your profile and channels', srn: 'Ask verification fu yu profiel en kanaal' },
  'profile.verificationIntro': { nl: 'Vul je gegevens in om verificatie aan te vragen.', en: 'Fill in your details to request verification.', srn: 'Fill in yu gegevens fu ask verification.' },
  'profile.verificationVerifiedTitle': { nl: 'Geverifieerd', en: 'Verified', srn: 'Verified' },
  'profile.verificationVerifiedDesc': { nl: 'Je profiel is al goedgekeurd.', en: 'Your profile has already been approved.', srn: 'Yu profiel already approved.' },
  'profile.verificationPendingTitle': { nl: 'In behandeling', en: 'Pending', srn: 'Pending' },
  'profile.verificationPendingDesc': { nl: 'We bekijken je verificatieaanvraag.', en: 'We are reviewing your verification request.', srn: 'Wi de review yu verification request.' },
  'profile.verificationApprovedTitle': { nl: 'Goedgekeurd', en: 'Approved', srn: 'Approved' },
  'profile.verificationApprovedDesc': { nl: 'Je aanvraag is goedgekeurd en wordt verwerkt.', en: 'Your request has been approved and is being processed.', srn: 'Yu request approved en de process.' },
  'profile.verificationRejectedTitle': { nl: 'Afgewezen', en: 'Rejected', srn: 'Rejected' },
  'profile.verificationRejectedDesc': { nl: 'Je aanvraag is afgewezen. Je kunt een nieuwe indienen.', en: 'Your request was rejected. You can submit a new one.', srn: 'Yu request rejected. Yu kan send wan njoe.' },
  'profile.verificationAboutLabel': { nl: 'Over jou', en: 'About you', srn: 'About yu' },
  'profile.verificationAboutPlaceholder': { nl: 'Vertel kort wie je bent en wat je doet', en: 'Briefly tell us who you are and what you do', srn: 'Skrifi who yu de en sani yu de do' },
  'profile.verificationMessageLabel': { nl: 'Bericht', en: 'Message', srn: 'Message' },
  'profile.verificationMessagePlaceholder': { nl: 'Waarom moet jij geverifieerd worden?', en: 'Why should you be verified?', srn: 'Why yu mus get verified?' },
  'profile.verificationSocialSection': { nl: 'Sociale links', en: 'Social links', srn: 'Social links' },
  'profile.verificationSocialHelp': { nl: 'Voeg links toe die je identiteit ondersteunen', en: 'Add links that support your identity', srn: 'Puti links fu support yu identity' },
  'profile.verificationTikTok': { nl: 'TikTok', en: 'TikTok', srn: 'TikTok' },
  'profile.verificationTiktokPlaceholder': { nl: 'TikTok profiel-URL', en: 'TikTok profile URL', srn: 'TikTok profile URL' },
  'profile.verificationYouTube': { nl: 'YouTube', en: 'YouTube', srn: 'YouTube' },
  'profile.verificationYoutubePlaceholder': { nl: 'YouTube kanaal-URL', en: 'YouTube channel URL', srn: 'YouTube channel URL' },
  'profile.verificationFacebook': { nl: 'Facebook', en: 'Facebook', srn: 'Facebook' },
  'profile.verificationFacebookPlaceholder': { nl: 'Facebook profiel-URL', en: 'Facebook profile URL', srn: 'Facebook profile URL' },
  'profile.verificationInstagram': { nl: 'Instagram', en: 'Instagram', srn: 'Instagram' },
  'profile.verificationInstagramPlaceholder': { nl: 'Instagram profiel-URL', en: 'Instagram profile URL', srn: 'Instagram profile URL' },
  'profile.verificationPressSection': { nl: 'Perslinks', en: 'Press links', srn: 'Press links' },
  'profile.verificationPressHelp': { nl: 'Plak links uit nieuws, interviews of persartikelen', en: 'Paste links from news, interviews or press articles', srn: 'Puti links fu news, interviews of press articles' },
  'profile.verificationPressPlaceholder': { nl: 'Één link per regel', en: 'One link per line', srn: 'Wan link per line' },
  'profile.verificationSubmit': { nl: 'Verificatie aanvragen', en: 'Request verification', srn: 'Ask verification' },
  'profile.verificationToastAboutRequired': { nl: 'Vul eerst je beschrijving in.', en: 'Fill in your description first.', srn: 'Fill in yu description fas.' },
  'profile.verificationToastMessageRequired': { nl: 'Vul eerst je bericht in.', en: 'Fill in your message first.', srn: 'Fill in yu message fas.' },
  'profile.verificationSubmitted': { nl: 'Verificatieaanvraag verzonden', en: 'Verification request sent', srn: 'Verification request send' },
  'profile.verificationToastFailed': { nl: 'Verificatieaanvraag mislukt', en: 'Verification request failed', srn: 'Verification request fail' },
} as const;

type TranslationKey = keyof typeof translations;

let currentLanguage: Language = 'en';

function notifyLanguageChange() {
  languageListeners.forEach((listener) => listener());
}

export async function loadSavedLanguage() {
  try {
    const saved = await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === 'en' || saved === 'nl' || saved === 'srn') {
      currentLanguage = saved;
      notifyLanguageChange();
    }
  } catch {
    // Keep English default on errors.
  }
}

export function setLanguage(lang: Language) {
  currentLanguage = lang;
  notifyLanguageChange();
  void AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function useLanguage() {
  return useSyncExternalStore(
    (listener: () => void) => {
      languageListeners.add(listener);
      return () => languageListeners.delete(listener);
    },
    getLanguage,
    getLanguage
  );
}

export function t(key: TranslationKey): string {
  const entry = translations[key];
  if (!entry) return key;
  return entry[currentLanguage] || entry.en || key;
}