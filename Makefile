#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2016, Joyent, Inc.
#

#
# Tools
#
NPM		:= $(shell which npm)
NPM_EXEC	:= npm
TAP		:= ./node_modules/.bin/tape


#
# Files
#
JS_FILES	:= $(shell find lib test -name '*.js')
JSL_CONF_NODE	 = tools/jsl.node.conf
JSL_FILES_NODE	 = $(JS_FILES)
JSSTYLE_FILES	 = $(JS_FILES)
JSSTYLE_FLAGS	 = -f tools/jsstyle.conf

include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.node_deps.defs

#
# Repo-specific targets
#
.PHONY: all
all: $(REPO_DEPS)
	$(NPM_EXEC) install

CLEAN_FILES += $(TAP) ./node_modules/tap

.PHONY: test
test: all
	TAP=1 $(TAP) test/*.test.js

.PHONY: coverage
coverage: all
	$(NPM_EXEC) install istanbul && \
	    ./node_modules/.bin/istanbul cover \
	    $(TAP) test/*.js

include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.node_deps.targ
include ./tools/mk/Makefile.targ
