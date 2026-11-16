//go:build darwin

package main

import (
	"strings"

	"go.bug.st/serial"
)

// macOS (agent compilé sans cgo) : pas de fabricant USB, on reconnaît les ports USB-série à leur nom
func listerPortsUSB() []portUSB {
	ports, _ := serial.GetPortsList()
	var l []portUSB
	for _, p := range ports {
		if strings.HasPrefix(p, "/dev/cu.usbmodem") || strings.HasPrefix(p, "/dev/cu.usbserial") || strings.HasPrefix(p, "/dev/cu.SLAB") || strings.HasPrefix(p, "/dev/cu.wchusbserial") {
			l = append(l, portUSB{Nom: p, VID: "?"})
		}
	}
	return l
}
