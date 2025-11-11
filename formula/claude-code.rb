class ClaudeCode < Formula
  desc "CLI tool for managing isolated Claude Code Docker instances"
  homepage "https://github.com/yourusername/llm-docker"
  url "https://github.com/yourusername/llm-docker/archive/refs/tags/v1.0.0.tar.gz"
  sha256 "" # TODO: Add SHA256 hash after creating release
  license "MIT"
  version "1.0.0"

  depends_on "docker"
  depends_on "docker-compose"

  def install
    # Install library files
    libexec.install "lib"

    # Install binaries
    bin.install "bin/cc-start"
    bin.install "bin/cc-stop"
    bin.install "bin/cc-exec"
    bin.install "bin/cc-shell"
    bin.install "bin/cc-rm"
    bin.install "bin/cc-clean"
    bin.install "bin/cc-list"
    bin.install "bin/cc-init"
    bin.install "bin/cc-config"
    bin.install "bin/cc-build"
    bin.install "bin/cc-setup"

    # Create data directories
    (var/"claude-code/claude-data").mkpath
    (var/"claude-code/git-data").mkpath
    (var/"claude-code/shared").mkpath
  end

  def caveats
    <<~EOS
      Claude Code has been installed!

      Setup Instructions:
      ===================

      1. Make sure Docker Desktop is installed and running:
         https://www.docker.com/products/docker-desktop

      2. Install and authenticate Claude CLI:
         npm install -g @anthropic-ai/claude-code
         claude login

      3. Run setup to build the Docker image:
         cc-setup

      4. Navigate to your project and initialize:
         cd /path/to/your/project
         cc-init

      5. Start Claude Code:
         cc-start

      Configuration:
      ==============

      Each project stores its configuration in .claude-code/config

      The configuration is auto-detected from your git repository:
      - Repository URL from: git config --get remote.origin.url
      - Branch from: git branch --show-current

      You'll be prompted interactively for any missing configuration.

      Commands:
      =========

      cc-setup          - Initial setup (extract credentials, build image)
      cc-init           - Initialize project configuration
      cc-config         - View/edit project configuration
      cc-start [name]   - Start/create instance
      cc-exec [name]    - Connect to existing instance
      cc-shell [name]   - Open shell in instance
      cc-stop [name]    - Stop instance
      cc-rm [name]      - Remove instance
      cc-clean          - Remove all stopped instances
      cc-list           - List all instances
      cc-build          - Rebuild Docker image

      Data Directories:
      =================

      Credentials: #{var}/claude-code/claude-data
      Git config:  #{var}/claude-code/git-data
      Shared:      #{var}/claude-code/shared

      For more information:
      https://github.com/yourusername/llm-docker
    EOS
  end

  test do
    system "#{bin}/cc-list"
  end
end
