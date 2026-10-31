UUID := skylight@hazard7546
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SOURCES := metadata.json extension.js prefs.js stylesheet.css lib schemas
ZIP := $(UUID).shell-extension.zip
ESLINT := npx --yes eslint@10.1.0

.PHONY: all schemas install uninstall pack dist test lint clean

all: schemas

schemas:
	glib-compile-schemas schemas/

install: schemas
	rm -rf $(DEST)
	mkdir -p $(DEST)
	cp -r $(SOURCES) $(DEST)/

uninstall:
	rm -rf $(DEST)

# With GNOME Shell's own tool.
pack:
	gnome-extensions pack --force --extra-source=lib .

# The same zip without GNOME Shell installed (CI). VERSION=x sets version-name.
dist:
	rm -rf build $(ZIP)
	mkdir -p build/$(UUID)
	cp -r $(SOURCES) build/$(UUID)/
	rm -f build/$(UUID)/schemas/gschemas.compiled
	glib-compile-schemas --strict build/$(UUID)/schemas
ifdef VERSION
	node -e 'const fs = require("fs"), [f, v] = process.argv.slice(1), m = JSON.parse(fs.readFileSync(f)); m["version-name"] = v; fs.writeFileSync(f, JSON.stringify(m, null, 2) + "\n")' build/$(UUID)/metadata.json "$(VERSION)"
endif
	cd build/$(UUID) && zip -qr ../../$(ZIP) .

test:
	node --test tests/*.mjs

lint:
	$(ESLINT) .

clean:
	rm -rf build schemas/gschemas.compiled $(ZIP)
