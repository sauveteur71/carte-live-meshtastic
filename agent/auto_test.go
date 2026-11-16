package main

import (
	"bytes"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestReglagesIntegres(t *testing.T) {
	binaire := append(bytes.Repeat([]byte{0x7f, 'E', 'L', 'F', 0}, 3000), []byte("\nCARTE-LIVE-AGENT{\"serveurs\":[\"nas.example.ts.net:4404\"],\"code\":\"ABCD-EFGH-JKLM\",\"carte\":\"Carte live\",\"role\":\"principal\"}\n")...)
	f := filepath.Join(t.TempDir(), "agent.exe")
	if err := os.WriteFile(f, binaire, 0755); err != nil {
		t.Fatal(err)
	}
	r := lireReglagesIntegres(f)
	if r == nil || r.Code != "ABCD-EFGH-JKLM" || len(r.Serveurs) != 1 || r.Serveurs[0] != "nas.example.ts.net:4404" {
		t.Fatalf("réglages intégrés mal lus : %+v", r)
	}
	if lireReglagesIntegres(os.Args[0]) != nil {
		t.Fatal("un programme sans réglages ne doit rien renvoyer")
	}
	if extraireReglages([]byte("\nCARTE-LIVE-AGENT{\"serveurs\":[],\"code\":\"X\"}\n")) != nil {
		t.Fatal("réglages sans serveur acceptés")
	}
}

func TestDetecterType(t *testing.T) {
	cas := map[string][]byte{
		"meshtastic": {0x00, 0x94, 0xc3, 0x00, 0x05},
		"meshcore":   {0x3e, 0x40, 0x00, 13, 9},
		"":           []byte("INFO | boot\r\n"),
	}
	for attendu, b := range cas {
		if got := detecterType(b); got != attendu {
			t.Errorf("detecterType(% x) = %q, attendu %q", b, got, attendu)
		}
	}
}

// Faux module série : répond à la question de son protocole, rien sinon
type fauxModule struct {
	genre  string
	mu     sync.Mutex
	sortie bytes.Buffer
}

func (m *fauxModule) Write(b []byte) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.genre == "meshtastic" && len(b) > 1 && b[0] == 0x94 && b[1] == 0xc3 {
		m.sortie.Write([]byte{0x94, 0xc3, 0x00, 0x02, 0x08, 0x01})
	}
	if m.genre == "meshcore" && len(b) > 0 && b[0] == 0x3c {
		m.sortie.Write([]byte{0x3e, 0x04, 0x00, 13, 9, 1, 2, 3})
	}
	return len(b), nil
}

func (m *fauxModule) Read(b []byte) (int, error) {
	m.mu.Lock()
	n, _ := m.sortie.Read(b)
	m.mu.Unlock()
	if n == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	return n, nil
}

func TestReconnaitre(t *testing.T) {
	for _, genre := range []string{"meshtastic", "meshcore"} {
		if got := reconnaitre(&fauxModule{genre: genre}, 2*time.Second); got != genre {
			t.Errorf("module %s reconnu comme %q", genre, got)
		}
	}
	debut := time.Now()
	if got := reconnaitre(&fauxModule{genre: "muet"}, 600*time.Millisecond); got != "" || time.Since(debut) > 2*time.Second {
		t.Errorf("appareil muet : %q en %s", got, time.Since(debut))
	}
}

func TestServeursDe(t *testing.T) {
	l := serveursDe(Reglages{Serveurs: []string{"a:4404", "b:4404"}, Serveur: "a:4404"})
	if len(l) != 2 || l[0] != "a:4404" || l[1] != "b:4404" {
		t.Fatalf("serveursDe = %v", l)
	}
}
