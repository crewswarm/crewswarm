class CrewCli < Formula
  desc "Command-line interface for CrewSwarm agent orchestration"
  homepage "https://crewswarm.ai"
  url "https://registry.npmjs.org/@crewswarm/crew-cli/-/crew-cli-0.1.0.tgz"
  sha256 "REPLACE_WITH_SHA256"
  license "MIT"

  depends_on "node" >= "20.0.0"

  def install
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    system "#{bin}/crew", "--version"
  end
end
