UUID := skylight@hazard7546
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES := metadata.json extension.js prefs.js stylesheet.css lib schemas

.PHONY: all schemas install uninstall pack test clean

all: schemas

schemas:
	glib-compile-schemas schemas/

install: schemas
	rm -rf $(DEST)
	mkdir -p $(DEST)
	cp -r $(SOURCES) $(DEST)/

uninstall:
	rm -rf $(DEST)

pack:
	gnome-extensions pack --force --extra-source=lib .

test:
	node --test tests/*.mjs

clean:
	rm -f schemas/gschemas.compiled $(UUID).shell-extension.zip
