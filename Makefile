.PHONY: setup dev test e2e e2e-mock
setup:
	npm install
dev:
	npm run dev
test:
	npm test
e2e:
	npm run e2e:live
e2e-mock:
	npm run e2e:mock
