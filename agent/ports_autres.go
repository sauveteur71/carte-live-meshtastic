//go:build !darwin

package main

import (
	"strings"

	"go.bug.st/serial/enumerator"
)

// Ports USB-série présents, avec le fabricant de la puce USB (VID) quand le système le donne
func listerPortsUSB() []portUSB {
	details, err := enumerator.GetDetailedPortsList()
	if err != nil {
		return nil
	}
	var l []portUSB
	for _, d := range details {
		if !d.IsUSB {
			continue
		}
		l = append(l, portUSB{Nom: d.Name, VID: strings.ToLower(d.VID), Produit: d.Product})
	}
	return l
}
