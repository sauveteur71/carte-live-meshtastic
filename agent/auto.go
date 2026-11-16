package main

// ---- Agent 1.7 : zéro question ----------------------------------------------------------------------------
// 1. L'agent téléchargé depuis la carte (Réseau › Modules › « Agent prêt à l'emploi ») porte à la fin de son fichier
//    l'adresse de la carte et le code secret : il n'a rien à demander.
// 2. Il surveille les ports USB du PC. Un module branché est reconnu (Meshtastic ou companion MeshCore), puis relié
//    tout de suite à la carte ; débranché, il est libéré ; le suivant branché prend sa place.
// Seules les puces USB des modules LoRa courants sont interrogées, pour ne rien envoyer à une imprimante 3D, un
// Arduino ou un autre appareil série du PC (option -tous-ports pour élargir).

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"go.bug.st/serial"
)

const marqueurReglages = "CARTE-LIVE-AGENT"

// Réglages ajoutés par la carte à la fin du programme téléchargé
type ReglagesIntegres struct {
	Serveurs []string `json:"serveurs"`
	Code     string   `json:"code"`
	Carte    string   `json:"carte"`
	Role     string   `json:"role"`
}

func lireReglagesIntegres(fichier string) *ReglagesIntegres {
	f, err := os.Open(fichier)
	if err != nil {
		return nil
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil
	}
	taille := st.Size()
	debut := taille - 4096
	if debut < 0 {
		debut = 0
	}
	fin := make([]byte, taille-debut)
	if _, err := f.ReadAt(fin, debut); err != nil && err != io.EOF {
		return nil
	}
	return extraireReglages(fin)
}

func extraireReglages(fin []byte) *ReglagesIntegres {
	i := bytes.LastIndex(fin, []byte("\n"+marqueurReglages+"{"))
	if i < 0 {
		return nil
	}
	j := i + 1 + len(marqueurReglages)
	k := bytes.IndexByte(fin[j:], '\n')
	if k < 0 {
		return nil
	}
	var r ReglagesIntegres
	if json.Unmarshal(fin[j:j+k], &r) != nil || r.Code == "" || len(r.Serveurs) == 0 {
		return nil
	}
	return &r
}

// Un port USB-série du PC
type portUSB struct {
	Nom     string
	VID     string // fabricant de la puce USB, en hexadécimal ; « ? » si le système ne le donne pas
	Produit string
}

// Puces USB des modules LoRa courants
var vidModules = map[string]string{
	"10c4": "CP210x",           // Heltec V2/V3, T-Beam, Station G1…
	"1a86": "CH340/CH9102",     // Heltec V3 récents, T-Beam Supreme, cartes chinoises
	"0403": "FTDI",             //
	"067b": "PL2303",           //
	"303a": "ESP32-S3 natif",   // Station G2, T-Deck, Heltec Wireless Tracker…
	"239a": "nRF52 (Adafruit)", // RAK4631, T-Echo, Heltec T114, Wio…
	"2886": "Seeed",            // Wio Tracker, XIAO
	"1915": "Nordic",           //
	"2e8a": "RP2040",           // RAK11310, Pico
}

// Ponts USB-série : DTR et RTS baissés, sinon la carte ESP32 redémarre à l'ouverture du port.
// USB natif (nRF52, ESP32-S3) : DTR levé, sinon le firmware croit que personne n'écoute (companion MeshCore muet).
func estPontUsbSerie(vid string) bool {
	switch vid {
	case "10c4", "1a86", "0403", "067b":
		return true
	}
	return false
}

func ouvrirPortUSB(p portUSB) (serial.Port, error) {
	pont := estPontUsbSerie(p.VID)
	bits := &serial.ModemOutputBits{DTR: !pont, RTS: !pont}
	port, err := serial.Open(p.Nom, &serial.Mode{BaudRate: 115200, InitialStatusBits: bits})
	if err != nil {
		var err2 error
		if port, err2 = serial.Open(p.Nom, &serial.Mode{BaudRate: 115200}); err2 != nil {
			return nil, err
		}
	}
	return port, nil
}

// Type de module d'après ce qu'il a répondu : companion MeshCore (« > », code 13 SELF_INFO… ou 1 OK court) ou
// Meshtastic (en-tête 0x94 0xC3 du flux série). Même règle que la page de la carte.
func detecterType(b []byte) string {
	if i := bytes.IndexByte(b, 0x3e); i >= 0 && i+3 < len(b) {
		if b[i+3] == 13 || (b[i+3] == 1 && int(b[i+1])|int(b[i+2])<<8 <= 4) {
			return "meshcore"
		}
	}
	if bytes.Contains(b, []byte{0x94, 0xc3}) {
		return "meshtastic"
	}
	return ""
}

// Pose les deux questions (MeshCore DEVICE_QUERY, Meshtastic want_config_id) toutes les 2,5 s pendant 8 s au plus :
// le module redémarre souvent à l'ouverture du port.
func reconnaitre(port io.ReadWriter, duree time.Duration) string {
	questionner := func() {
		port.Write([]byte{0x3c, 0x02, 0x00, 22, 3})
		port.Write(bytes.Repeat([]byte{0xc3}, 32))
		port.Write([]byte{0x94, 0xc3, 0x00, 0x03, 0x18, 0xb9, 0x60}) // ToRadio { want_config_id: 12345 }
	}
	questionner()
	prochaine := time.Now().Add(2500 * time.Millisecond)
	limite := time.Now().Add(duree)
	var recu []byte
	tmp := make([]byte, 512)
	for time.Now().Before(limite) {
		n, err := port.Read(tmp)
		if n > 0 {
			recu = append(recu, tmp[:n]...)
			if t := detecterType(recu); t != "" {
				return t
			}
			if len(recu) > 8192 {
				recu = recu[len(recu)-4096:]
			}
		}
		if err != nil && err != io.EOF {
			return ""
		}
		if time.Now().After(prochaine) {
			questionner()
			prochaine = time.Now().Add(2500 * time.Millisecond)
		}
	}
	return ""
}

// Serveurs à essayer, dans l'ordre (adresse vue par le navigateur au téléchargement, puis les autres)
func serveursDe(r Reglages) []string {
	var l []string
	vu := map[string]bool{}
	for _, s := range append(append([]string{}, r.Serveurs...), r.Serveur) {
		s = strings.TrimSpace(s)
		if s != "" && !vu[s] {
			vu[s] = true
			l = append(l, s)
		}
	}
	return l
}

var muServeur sync.Mutex
var serveurQuiRepond string

func joindreServeur(r Reglages) (net.Conn, string, error) {
	muServeur.Lock()
	prefere := serveurQuiRepond
	muServeur.Unlock()
	liste := serveursDe(r)
	if prefere != "" {
		liste = append([]string{prefere}, liste...)
	}
	var derniere error
	for _, s := range liste {
		c, err := net.DialTimeout("tcp", s, 8*time.Second)
		if err == nil {
			muServeur.Lock()
			serveurQuiRepond = s
			muServeur.Unlock()
			return c, s, nil
		}
		derniere = err
	}
	return nil, "", derniere
}

func portPresent(nom string) bool {
	for _, p := range listerPortsUSB() {
		if p.Nom == nom {
			return true
		}
	}
	return false
}

// Surveillance des ports USB : chaque module branché a sa session tant qu'il reste branché
func detection(r Reglages, role string, exclus map[string]bool, tousPorts bool) {
	var mu sync.Mutex
	suivis := map[string]bool{} // ports en cours de traitement (session, ou appareil qui n'est pas un module)
	annonce := false
	for {
		for _, p := range listerPortsUSB() {
			mu.Lock()
			deja := suivis[p.Nom]
			mu.Unlock()
			if deja || exclus[strings.ToUpper(p.Nom)] {
				continue
			}
			_, connu := vidModules[p.VID]
			if !connu && p.VID != "?" && !tousPorts {
				continue
			}
			mu.Lock()
			suivis[p.Nom] = true
			mu.Unlock()
			go func(p portUSB) {
				sessionPort(r, role, p)
				// La session ne rend la main que quand le port a disparu (ou n'est pas un module : on attend alors
				// qu'il soit débranché avant de le réessayer)
				for portPresent(p.Nom) {
					time.Sleep(3 * time.Second)
				}
				mu.Lock()
				delete(suivis, p.Nom)
				mu.Unlock()
			}(p)
		}
		if !annonce {
			journal("détection USB active : branchez un module Meshtastic ou un companion MeshCore, il sera relié tout seul à la carte")
			annonce = true
		}
		time.Sleep(2 * time.Second)
	}
}

// Un port USB : reconnaissance du module puis relais vers la carte, repris tant que le module reste branché
func sessionPort(r Reglages, role string, p portUSB) {
	time.Sleep(1500 * time.Millisecond) // le module démarre juste après le branchement
	puce := vidModules[p.VID]
	if puce == "" {
		puce = "USB"
	}
	port, err := ouvrirPortUSB(p)
	if err != nil {
		journal("[%s] port occupé (appli Meshtastic / MeshCore, page de la carte ou autre programme ?) : %v", p.Nom, err)
		return
	}
	port.SetReadTimeout(300 * time.Millisecond)
	genre := reconnaitre(port, 8*time.Second)
	port.Close()
	if genre == "" {
		journal("[%s] appareil %s qui ne répond ni comme Meshtastic ni comme companion MeshCore (firmware répéteur, room server ou « companion BLE » ?) : ignoré tant qu'il reste branché", p.Nom, puce)
		return
	}
	libelle := map[string]string{"meshtastic": "module Meshtastic", "meshcore": "companion MeshCore"}[genre]
	journal("[%s] %s reconnu (%s)", p.Nom, libelle, puce)
	nom := nomPC() + " · " + strings.TrimPrefix(p.Nom, "/dev/")
	for portPresent(p.Nom) {
		attente, fini := sessionDirecte(r, role, p, genre, nom, libelle)
		if fini {
			return
		}
		time.Sleep(attente)
	}
	journal("[%s] %s débranché", p.Nom, libelle)
}

// Une liaison avec la carte pour un module reconnu. Renvoie le délai avant de réessayer, ou fini=true si le port a
// disparu ou si la carte est trop ancienne pour le mode direct (on passe alors au mode classique).
func sessionDirecte(r Reglages, role string, p portUSB, genre, nom, libelle string) (time.Duration, bool) {
	c, serveur, err := joindreServeur(r)
	if err != nil {
		journal("[%s] carte injoignable (%v) — Tailscale est-il actif ? Nouvel essai dans 20 s", p.Nom, err)
		return 20 * time.Second, false
	}
	defer c.Close()
	if tc, ok := c.(*net.TCPConn); ok {
		tc.SetKeepAlive(true)
		tc.SetKeepAlivePeriod(30 * time.Second)
		tc.SetNoDelay(true)
	}
	type bonjour struct {
		V         int    `json:"v"`
		Code      string `json:"code"`
		Nom       string `json:"nom"`
		Source    string `json:"source"`
		Version   string `json:"version"`
		Direct    bool   `json:"direct"`
		Protocole string `json:"protocole"`
		Role      string `json:"role"`
	}
	b, _ := json.Marshal(bonjour{1, r.Code, nom, "USB " + p.Nom, version, true, genre, role})
	c.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := c.Write(append(b, '\n')); err != nil {
		return 20 * time.Second, false
	}
	lecteur := bufio.NewReader(c)
	l, err := lecteur.ReadString('\n')
	if err != nil {
		journal("[%s] la carte ne répond pas encore (redémarrage ?) : nouvel essai dans 30 s", p.Nom)
		return 30 * time.Second, false
	}
	l = strings.TrimSpace(l)
	if strings.HasPrefix(l, "ERREUR") {
		journal("[%s] refusé par la carte : %s", p.Nom, strings.TrimSpace(strings.TrimPrefix(l, "ERREUR")))
		return 60 * time.Second, false
	}
	if l != "OK direct" {
		// Carte plus ancienne : le module est proposé dans Réseau › Modules, à choisir à la main
		c.Close()
		journal("[%s] cette carte ne relie pas encore les modules tout seuls (mettez-la à jour) : %s proposé dans Réseau › Modules", p.Nom, libelle)
		cx := Connexion{Nom: nom, Source: p.Nom}
		for portPresent(p.Nom) {
			time.Sleep(boucle(serveur, r.Code, cx))
		}
		return 0, true
	}
	c.SetDeadline(time.Time{})
	port, err := ouvrirPortUSB(p)
	if err != nil {
		journal("[%s] ouverture impossible (%v) : port pris par un autre programme ?", p.Nom, err)
		return 15 * time.Second, false
	}
	journal("[%s] %s relié à la carte%s", p.Nom, libelle, map[bool]string{true: " (en écoute)", false: ""}[role == "ecoute"])
	debut := time.Now()
	var once sync.Once
	fin := make(chan string, 2)
	fermer := func() { once.Do(func() { c.Close(); port.Close() }) }
	go func() { // module → carte
		io.Copy(c, port)
		fin <- "module"
		fermer()
	}()
	go func() { // carte → module
		io.Copy(port, lecteur)
		fin <- "carte"
		fermer()
	}()
	cote := <-fin
	fermer()
	if !portPresent(p.Nom) {
		journal("[%s] %s débranché après %s : libéré", p.Nom, libelle, time.Since(debut).Round(time.Second))
		return 0, true
	}
	if cote == "carte" {
		journal("[%s] la carte a fermé la liaison (autre module choisi, redémarrage) : reprise dans 10 s", p.Nom)
		return 10 * time.Second, false
	}
	journal("[%s] le module a coupé la liaison : reprise dans 5 s", p.Nom)
	return 5 * time.Second, false
}
